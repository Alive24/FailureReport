import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { FailureReport } from "@failure-report/protocol";

export type JsonRpcRequest = {
  id: number;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type TurnCompletion = {
  threadId: string;
  turn: {
    id: string;
    status?: string;
  };
};

export type CodexAppServerOptions = {
  command: string;
  arguments: string[];
  timeout_ms: number;
  cwd?: string;
  model?: string;
  approval_policy?: string;
};

export type CodexInvestigationRequest = {
  report: FailureReport;
  workspace: string;
  request: string;
  thread_id?: string;
};

export type CodexInvestigationResult = {
  thread_id: string;
  turn_id: string;
  status: string;
  assistant_text: string;
};

export class JsonRpcRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcRequestError";
  }
}

export class JsonRpcSession {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();

  constructor(
    private readonly send: (
      message: JsonRpcRequest | JsonRpcNotification,
    ) => void,
    private readonly timeoutMs: number,
  ) {}

  onNotification(
    listener: (notification: JsonRpcNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "Timed out waiting for Codex App-server response to " +
              method +
              ".",
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  receive(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }

    if (typeof value.id === "number") {
      this.receiveResponse(value as JsonRpcResponse);
      return;
    }

    if (typeof value.method === "string") {
      const notification: JsonRpcNotification = {
        method: value.method,
        ...("params" in value ? { params: value.params } : {}),
      };
      for (const listener of this.notificationListeners) {
        listener(notification);
      }
    }
  }

  close(reason = "Codex App-server connection closed."): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private receiveResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);

    if (response.error) {
      pending.reject(
        new JsonRpcRequestError(
          response.error.code,
          response.error.message,
          response.error.data,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }
}

export class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private session?: JsonRpcSession;
  private readonly completedTurns = new Map<string, TurnCompletion>();
  private readonly turnWaiters = new Map<
    string,
    (completion: TurnCompletion) => void
  >();
  private readonly assistantText = new Map<string, string>();

  constructor(private readonly options: CodexAppServerOptions) {}

  async start(): Promise<void> {
    if (this.session) {
      return;
    }

    const child = spawn(this.options.command, this.options.arguments, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const session = new JsonRpcSession((message) => {
      child.stdin.write(JSON.stringify(message) + "\n");
    }, this.options.timeout_ms);
    this.session = session;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message: unknown = JSON.parse(line);
        session.receive(message);
        this.captureNotification(message);
      } catch {
        // App-server stdout is JSONL. Ignore malformed diagnostics defensively.
      }
    });
    child.once("error", (error) => session.close(error.message));
    child.once("close", (code) => {
      session.close("Codex App-server exited with code " + String(code) + ".");
    });

    await session.request("initialize", {
      clientInfo: {
        name: "failure_report",
        title: "FailureReport",
        version: "0.1.0",
      },
    });
    session.notify("initialized", {});
  }

  async runInvestigation(
    input: CodexInvestigationRequest,
  ): Promise<CodexInvestigationResult> {
    await this.start();
    const session = this.requireSession();
    const threadId =
      input.thread_id ?? (await this.startThread(input.workspace));
    const turn = await session.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      cwd: input.workspace,
      model: this.options.model,
      input: [
        {
          type: "text",
          text: buildCodexInvestigationPrompt(input),
        },
      ],
    });
    const turnId = turn.turn.id;
    const completion = await this.waitForTurn(threadId, turnId);

    return {
      thread_id: threadId,
      turn_id: turnId,
      status: completion.turn.status ?? "completed",
      assistant_text: this.assistantText.get(turnKey(threadId, turnId)) ?? "",
    };
  }

  close(): void {
    this.session?.close();
    this.child?.kill();
    this.child = undefined;
    this.session = undefined;
  }

  private async startThread(workspace: string): Promise<string> {
    const session = this.requireSession();
    const response = await session.request<{ thread: { id: string } }>(
      "thread/start",
      {
        model: this.options.model,
        cwd: workspace,
        approvalPolicy: this.options.approval_policy,
      },
    );
    return response.thread.id;
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
  ): Promise<TurnCompletion> {
    const key = turnKey(threadId, turnId);
    const existing = this.completedTurns.get(key);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<TurnCompletion>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnWaiters.delete(key);
        reject(new Error("Timed out waiting for Codex turn completion."));
      }, this.options.timeout_ms);
      this.turnWaiters.set(key, (completion) => {
        clearTimeout(timeout);
        resolve(completion);
      });
    });
  }

  private requireSession(): JsonRpcSession {
    if (!this.session) {
      throw new Error("Codex App-server client has not been started.");
    }
    return this.session;
  }

  private captureNotification(message: unknown): void {
    if (!isRecord(message) || typeof message.method !== "string") {
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const params = message.params;
      if (
        isRecord(params) &&
        typeof params.threadId === "string" &&
        typeof params.turnId === "string" &&
        typeof params.delta === "string"
      ) {
        const key = turnKey(params.threadId, params.turnId);
        this.assistantText.set(
          key,
          (this.assistantText.get(key) ?? "") + params.delta,
        );
      }
      return;
    }
    if (message.method === "turn/completed") {
      const completion = toTurnCompletion(message.params);
      if (!completion) {
        return;
      }
      const key = turnKey(completion.threadId, completion.turn.id);
      this.completedTurns.set(key, completion);
      const resolve = this.turnWaiters.get(key);
      if (resolve) {
        this.turnWaiters.delete(key);
        resolve(completion);
      }
    }
  }
}

export function buildCodexInvestigationPrompt(
  input: CodexInvestigationRequest,
): string {
  return [
    "You are a bounded investigator called by the FailureReport Root.",
    "Do not publish or edit GitHub Issues. Do not widen the task beyond this request.",
    "Workspace: " + input.workspace,
    "Request: " + input.request,
    "",
    "The following is the current structured FailureReport shared context:",
    JSON.stringify(input.report, null, 2),
    "",
    "Return observed facts, commands or tests run, evidence references, the leading",
    "hypothesis, confidence, remaining uncertainty, and the smallest next action.",
  ].join("\n");
}

function turnKey(threadId: string, turnId: string): string {
  return threadId + ":" + turnId;
}

function toTurnCompletion(value: unknown): TurnCompletion | undefined {
  if (!isRecord(value) || typeof value.threadId !== "string") {
    return undefined;
  }
  const turn = value.turn;
  if (!isRecord(turn) || typeof turn.id !== "string") {
    return undefined;
  }
  return {
    threadId: value.threadId,
    turn: {
      id: turn.id,
      ...(typeof turn.status === "string" ? { status: turn.status } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
