import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Bounded stderr retained only for sanitized host-runtime diagnostics. */
const maximumCapturedDiagnosticChars = 4_096;
const childCleanupTimeoutMs = 1_000;

/** JSON-RPC ids accepted by the Codex App Server wire protocol. */
export type CodexAppServerRequestId = string | number;

/** One server notification delivered on a live App Server connection. */
export type CodexAppServerNotification = {
  method: string;
  params: unknown;
};

/** One server-initiated JSON-RPC request that still requires a live response. */
export type CodexAppServerServerRequest = {
  id: CodexAppServerRequestId;
  method: string;
  params: unknown;
};

/** Minimal JSON-RPC process surface shared by preflight and a live transport. */
export type CodexAppServerProcess = {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  dispose(): Promise<void>;
};

/** Persistent process surface needed by the direct diagnostic model adapter. */
export type DirectCodexAppServerProcess = CodexAppServerProcess & {
  respond(id: CodexAppServerRequestId, result: unknown): void;
  respondError(
    id: CodexAppServerRequestId,
    code: number,
    message: string,
  ): void;
  onNotification(
    handler: (notification: CodexAppServerNotification) => void | Promise<void>,
  ): () => void;
  onServerRequest(
    handler: (request: CodexAppServerServerRequest) => void | Promise<void>,
  ): () => void;
  onClose(handler: (error: Error) => void | Promise<void>): () => void;
};

/** Host process launcher intentionally limited to the caller's ambient runtime. */
export type CodexAppServerHostRuntime = {
  startAppServer(input: {
    executable: string;
    cwd: string;
  }): CodexAppServerProcess | Promise<CodexAppServerProcess>;
};

/** Direct adapters need the persistent live-event surface in addition to requests. */
export type DirectCodexAppServerHostRuntime = {
  startAppServer(input: {
    executable: string;
    cwd: string;
  }): DirectCodexAppServerProcess | Promise<DirectCodexAppServerProcess>;
};

/** Signals malformed App Server JSON-RPC traffic without exposing raw payloads. */
export class CodexAppServerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerProtocolError";
  }
}

/** Signals a closed or unusable host transport. */
export class CodexAppServerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerTransportError";
  }
}

/**
 * Default host launcher. It intentionally relies on Node's inherited ambient
 * environment so Root continues to use the user's installed Codex runtime,
 * authentication, skills, plugins, MCP configuration, and Git credentials.
 */
export const nodeCodexAppServerHostRuntime: DirectCodexAppServerHostRuntime = {
  startAppServer({ executable, cwd }) {
    const command = resolveCodexCommand(executable);
    const child = spawn(command.executable, [...command.args, "app-server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    return new NodeCodexAppServerProcess(child);
  },
};

/**
 * JSONL transport for a single persistent App Server process.
 *
 * Server request ids remain only in this object while the connection is alive.
 * The adapter above it is responsible for reducing a live approval to safe
 * terminal evidence before this process is discarded.
 */
export class NodeCodexAppServerProcess implements DirectCodexAppServerProcess {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Set<
    (notification: CodexAppServerNotification) => void | Promise<void>
  >();
  private readonly serverRequestHandlers = new Set<
    (request: CodexAppServerServerRequest) => void | Promise<void>
  >();
  private readonly closeHandlers = new Set<
    (error: Error) => void | Promise<void>
  >();
  private readonly closed: Promise<void>;
  private resolveClosed: (() => void) | undefined;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private stderr = "";
  private isClosed = false;
  private terminalFailure: CodexAppServerTransportError | undefined;
  private disposal: Promise<void> | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.closed = new Promise<void>((resolvePromise) => {
      this.resolveClosed = resolvePromise;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendBounded(this.stderr, chunk.toString("utf8"));
    });
    child.once("error", (error) => {
      this.finishClosed(
        new CodexAppServerTransportError(diagnosticText(error)),
      );
    });
    child.once("close", () => {
      this.finishClosed(
        this.terminalFailure ??
          new CodexAppServerTransportError(
            this.stderr || "Codex App Server exited before responding.",
          ),
      );
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    this.assertOpen();
    const id = this.nextRequestId++;
    const pendingKey = requestIdKey(id);
    return new Promise<unknown>((resolvePromise, reject) => {
      this.pending.set(pendingKey, { resolve: resolvePromise, reject });
      this.write({ id, method, params }, (error) => {
        if (error) {
          this.rejectRequest(
            pendingKey,
            new CodexAppServerTransportError(diagnosticText(error)),
          );
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.assertOpen();
    this.write({ method, params });
  }

  respond(id: CodexAppServerRequestId, result: unknown): void {
    this.assertOpen();
    this.write({ id, result });
  }

  respondError(
    id: CodexAppServerRequestId,
    code: number,
    message: string,
  ): void {
    this.assertOpen();
    this.write({ id, error: { code, message } });
  }

  onNotification(
    handler: (notification: CodexAppServerNotification) => void | Promise<void>,
  ): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(
    handler: (request: CodexAppServerServerRequest) => void | Promise<void>,
  ): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onClose(handler: (error: Error) => void | Promise<void>): () => void {
    this.closeHandlers.add(handler);
    if (this.isClosed) {
      invokeHandler(
        handler,
        this.terminalFailure ??
          new CodexAppServerTransportError(
            "Codex App Server is already closed.",
          ),
      );
    }
    return () => this.closeHandlers.delete(handler);
  }

  async dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposal = this.stop();
    }
    await this.disposal;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        // The server may write incidental non-protocol output. It is not a
        // durable diagnostic event and must not reach Eve's message stream.
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }
    if (isServerRequest(message)) {
      if (this.serverRequestHandlers.size === 0) {
        try {
          this.respondError(
            message.id,
            -32601,
            "FailureReport does not expose this Codex-native request to Eve.",
          );
        } catch {
          // A close race is already handled by the terminal transport path.
        }
        return;
      }
      for (const handler of this.serverRequestHandlers) {
        invokeHandler(handler, {
          id: message.id,
          method: message.method,
          params: message.params,
        });
      }
      return;
    }
    if (isResponse(message)) {
      const pendingKey = requestIdKey(message.id);
      const pending = this.pending.get(pendingKey);
      if (!pending) {
        return;
      }
      this.pending.delete(pendingKey);
      if ("error" in message && message.error !== undefined) {
        pending.reject(
          new CodexAppServerProtocolError(diagnosticText(message.error)),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (isNotification(message)) {
      for (const handler of this.notificationHandlers) {
        invokeHandler(handler, {
          method: message.method,
          params: message.params,
        });
      }
    }
  }

  private write(
    message: unknown,
    callback?: (error: Error | null | undefined) => void,
  ): void {
    try {
      this.child.stdin.write(JSON.stringify(message) + "\n", callback);
    } catch (error) {
      callback?.(new CodexAppServerTransportError(diagnosticText(error)));
      if (!callback) {
        throw new CodexAppServerTransportError(diagnosticText(error));
      }
    }
  }

  private assertOpen(): void {
    if (this.terminalFailure || this.isClosed) {
      throw (
        this.terminalFailure ??
        new CodexAppServerTransportError("Codex App Server is already closed.")
      );
    }
  }

  private rejectRequest(pendingKey: string, error: Error): void {
    const pending = this.pending.get(pendingKey);
    if (!pending) {
      return;
    }
    this.pending.delete(pendingKey);
    pending.reject(error);
  }

  private finishClosed(error: CodexAppServerTransportError): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.terminalFailure = error;
    this.resolveClosed?.();
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      invokeHandler(handler, error);
    }
  }

  private async stop(): Promise<void> {
    if (this.isClosed || this.child.exitCode !== null) {
      return;
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      return;
    }
    if (await settlesWithin(this.closed, childCleanupTimeoutMs)) {
      return;
    }
    try {
      this.child.kill("SIGKILL");
    } catch {
      return;
    }
    await settlesWithin(this.closed, childCleanupTimeoutMs);
  }
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

function resolveCodexCommand(executable: string): {
  executable: string;
  args: string[];
} {
  if (/\.(?:c|m)?js$/i.test(executable)) {
    return { executable: process.execPath, args: [executable] };
  }
  return { executable, args: [] };
}

function isServerRequest(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  id: CodexAppServerRequestId;
  method: string;
} {
  return isRequestId(value.id) && typeof value.method === "string";
}

function isResponse(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  id: CodexAppServerRequestId;
  result?: unknown;
  error?: unknown;
} {
  return (
    isRequestId(value.id) &&
    typeof value.method !== "string" &&
    ("result" in value || "error" in value)
  );
}

function isNotification(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { method: string } {
  return !("id" in value) && typeof value.method === "string";
}

function isRequestId(value: unknown): value is CodexAppServerRequestId {
  return typeof value === "string" || typeof value === "number";
}

function requestIdKey(id: CodexAppServerRequestId): string {
  return typeof id + ":" + String(id);
}

function invokeHandler<T>(
  handler: (value: T) => void | Promise<void>,
  value: T,
): void {
  void Promise.resolve(handler(value)).catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appendBounded(current: string, addition: string): string {
  return (current + addition).slice(-maximumCapturedDiagnosticChars);
}

function diagnosticText(value: unknown): string {
  if (value instanceof Error) {
    return value.message.slice(0, maximumCapturedDiagnosticChars);
  }
  if (typeof value === "string") {
    return value.slice(0, maximumCapturedDiagnosticChars);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const detail = diagnosticText(entry);
      if (detail !== "Codex App Server returned an unknown failure.") {
        return detail;
      }
    }
  }
  if (isRecord(value)) {
    const message = value.message;
    if (typeof message === "string") {
      return message.slice(0, maximumCapturedDiagnosticChars);
    }
    const error = value.error;
    if (typeof error === "string") {
      return error.slice(0, maximumCapturedDiagnosticChars);
    }
  }
  return "Codex App Server returned an unknown failure.";
}

function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    void operation.then(
      () => {
        clearTimeout(timer);
        resolvePromise(true);
      },
      () => {
        clearTimeout(timer);
        resolvePromise(true);
      },
    );
  });
}
