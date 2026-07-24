import { randomUUID } from "node:crypto";

import type { LanguageModel, ModelMessage } from "ai";

import {
  parseDiagnosticSessionEnvelope,
  type DiagnosticSessionEnvelope,
} from "../diagnostics/envelope.js";
import { getDomainExtensions } from "../diagnostics/domain-extensions.js";
import { DiagnosticSessionWorkpad } from "../diagnostics/workpad.js";
import { DiagnosticWorktreeManager } from "../diagnostics/worktree.js";
import {
  createDiagnosticNativeApprovalBroker,
  type NativeApprovalBroker,
  type NativeApprovalRegistration,
  type NativeApprovalRequestKind,
  type NativeApprovalSessionBinding,
} from "./native-approval-broker.js";
import {
  nodeCodexAppServerHostRuntime,
  type CodexAppServerNotification,
  type CodexAppServerRequestId,
  type CodexAppServerServerRequest,
  type DirectCodexAppServerHostRuntime,
  type DirectCodexAppServerProcess,
} from "./codex-app-server-transport.js";
import type { CodexAppServerBackendConfig } from "./codex-app-server-config.js";

/**
 * Root-owned adapter from Eve's dynamic-model hook to a direct Codex App Server
 * connection. It accepts only a Root-prepared diagnostic-session envelope,
 * recovers the Root-owned worktree, and keeps persistent thread state journaled
 * in the workpad. Codex-native actions never become Eve tool calls.
 */

type DiagnosticCodexWorkpad = Pick<
  DiagnosticSessionWorkpad,
  | "loadForDiagnosticSession"
  | "recordThread"
  | "recordCompletion"
  | "loadNativeApprovalSessionBinding"
  | "recordNativeApprovalTerminal"
>;

type CreateDiagnosticNativeApprovalBroker =
  typeof createDiagnosticNativeApprovalBroker;

/** Test seams for the direct Codex diagnostic-model factory. */
export type CodexAppServerModelFactoryDependencies = {
  diagnostic_session_workpad?: DiagnosticCodexWorkpad;
  host_runtime?: DirectCodexAppServerHostRuntime;
  create_native_approval_broker?: CreateDiagnosticNativeApprovalBroker;
};

/**
 * Builds Eve's dynamic model resolver for the consumer-owned Codex worker.
 * The resolver derives cwd, native skill links, and thread state only from a
 * Root-prepared envelope plus the durable GitHub workpad.
 */
export function createCodexAppServerModelResolver(
  config: CodexAppServerBackendConfig,
  dependencies: CodexAppServerModelFactoryDependencies = {},
): (messages: readonly ModelMessage[]) => Promise<{
  model: LanguageModel;
  modelContextWindowTokens: number;
}> {
  const hostRuntime =
    dependencies.host_runtime ?? nodeCodexAppServerHostRuntime;
  const createApprovalBroker =
    dependencies.create_native_approval_broker ??
    createDiagnosticNativeApprovalBroker;

  return async (messages) => {
    const envelope = parseDiagnosticSessionEnvelope(messages);
    const workpad =
      dependencies.diagnostic_session_workpad ??
      createDiagnosticSessionWorkpad(config, envelope);
    return {
      model: new DirectCodexAppServerLanguageModel({
        config,
        envelope,
        workpad,
        host_runtime: hostRuntime,
        create_approval_broker: createApprovalBroker,
      }) as unknown as LanguageModel,
      modelContextWindowTokens: config.model_context_window_tokens,
    };
  };
}

/**
 * Creates a fail-closed fallback required by Eve's dynamic-model API.
 * It cannot select a cwd or launch Codex, so malformed messages remain safe.
 */
export function createBlockedCodexAppServerModel(): LanguageModel {
  const blocked = async (): Promise<never> => {
    throw new Error(
      "Codex diagnosis may only run through a Root-prepared diagnostic-session envelope.",
    );
  };

  return {
    specificationVersion: "v3",
    provider: "failure-report-guard",
    modelId: "codex-diagnostic-session-required",
    supportedUrls: {},
    defaultObjectGenerationMode: "json",
    supportsStructuredOutputs: true,
    supportsImageUrls: false,
    doGenerate: blocked,
    doStream: blocked,
  } as unknown as LanguageModel;
}

type DirectCodexAppServerLanguageModelOptions = {
  config: CodexAppServerBackendConfig;
  envelope: DiagnosticSessionEnvelope;
  workpad: DiagnosticCodexWorkpad;
  host_runtime: DirectCodexAppServerHostRuntime;
  create_approval_broker: CreateDiagnosticNativeApprovalBroker;
};

/**
 * One Eve model wrapper owns exactly one direct App Server turn. Root recreates
 * the wrapper for a replay or resume, which prevents a stale connection from
 * silently crossing diagnostic-session or worktree boundaries.
 */
class DirectCodexAppServerLanguageModel {
  readonly specificationVersion = "v3" as const;
  readonly provider = "failure-report-codex-app-server";
  readonly modelId: string;
  readonly supportedUrls = {};
  readonly defaultObjectGenerationMode = "json" as const;
  readonly supportsStructuredOutputs = true;
  readonly supportsImageUrls = true;
  private started = false;

  constructor(
    private readonly options: DirectCodexAppServerLanguageModelOptions,
  ) {
    this.modelId = options.config.model;
  }

  async doStream(
    callOptions: unknown,
  ): Promise<{ stream: ReadableStream<unknown> }> {
    if (this.started) {
      throw new Error(
        "A direct Codex App Server model wrapper may only own one diagnostic turn.",
      );
    }
    this.started = true;
    return startDirectCodexTurn(this.options, callOptions);
  }

  async doGenerate(callOptions: unknown): Promise<unknown> {
    const result = await this.doStream(callOptions);
    const reader = result.stream.getReader();
    let text = "";
    let finishReason: unknown = { unified: "other", raw: "unknown" };
    let usage: unknown = emptyUsage();
    const warnings: unknown[] = [];

    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      if (!isRecord(next.value)) {
        continue;
      }
      if (
        next.value.type === "text-delta" &&
        typeof next.value.delta === "string"
      ) {
        text += next.value.delta;
      } else if (next.value.type === "finish") {
        finishReason = next.value.finishReason ?? finishReason;
        usage = next.value.usage ?? usage;
      } else if (
        next.value.type === "stream-start" &&
        Array.isArray(next.value.warnings)
      ) {
        warnings.push(...next.value.warnings);
      }
    }

    return {
      content: text ? [{ type: "text", text }] : [],
      finishReason,
      usage,
      warnings,
      response: {
        id: randomUUID(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
    };
  }
}

/** Binds generic diagnostic identity to a fresh durable workpad when not injected. */
function createDiagnosticSessionWorkpad(
  config: CodexAppServerBackendConfig,
  envelope: DiagnosticSessionEnvelope,
): DiagnosticSessionWorkpad {
  return new DiagnosticSessionWorkpad({
    worktrees: new DiagnosticWorktreeManager({
      domainExtensions: getDomainExtensions(envelope.domain_extensions),
      backendId: config.kind,
    }),
  });
}

type DirectTurn = {
  stream: ReadableStream<unknown>;
};

type LiveNativeApproval = {
  registration: NativeApprovalRegistration;
  item_id: string | undefined;
  kind: NativeApprovalRequestKind;
};

const directDiagnosticBoundaryInstructions = [
  "This is a FailureReport diagnostic session in a Root-managed worktree.",
  "workspace-write permits only focused tests, caches, and ephemeral diagnostic evidence.",
  "Do not make target-repository business-code changes, commit, push, create a branch or pull request, or invoke diagnostic finalization.",
  "Return evidence and recommendations to Root, which remains the sole owner of the diagnostic-session lifecycle.",
].join(" ");

/**
 * Starts one persistent thread and one turn over a direct host-managed process.
 * The process is kept open for the complete live turn because approval request
 * ids are connection-local and cannot be safely replayed after process loss.
 */
async function startDirectCodexTurn(
  options: DirectCodexAppServerLanguageModelOptions,
  callOptions: unknown,
): Promise<DirectTurn> {
  const prompt = extractPrompt(callOptions);
  const loaded = await options.workpad.loadForDiagnosticSession(
    options.envelope,
  );
  const cwd = loaded.diagnostic_session.state.worktree.path;
  const process = await options.host_runtime.startAppServer({
    executable: options.config.codex_path,
    cwd,
  });
  const bridge = createStreamBridge();
  const unsubscribers: Array<() => void> = [];
  let processDisposed = false;
  let terminal = false;
  let turnReady = false;
  let threadId = "";
  let turnId = "";
  let broker: NativeApprovalBroker | undefined;
  let binding: NativeApprovalSessionBinding | undefined;
  let abortSignal: AbortSignal | undefined;
  let abortHandler: (() => void) | undefined;
  const approvals = new Map<string, LiveNativeApproval>();
  const pendingTurnEvents: Array<() => Promise<void>> = [];
  let eventChain = Promise.resolve();

  const dispose = async (): Promise<void> => {
    if (processDisposed) {
      return;
    }
    processDisposed = true;
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
    try {
      await process.dispose();
    } catch {
      // Process cleanup is best effort. The workpad's terminal evidence is the
      // durable outcome; a late child failure must not reopen the approval.
    }
  };

  const interruptLiveApproval = async (): Promise<void> => {
    if (!broker) {
      return;
    }
    try {
      await broker.interrupt();
    } catch {
      // The broker has already attempted its fail-closed response. Do not
      // retry a connection-local request after a terminal transport failure.
    }
  };

  const failForInterruptedProcess = async (): Promise<void> => {
    if (terminal) {
      return;
    }
    terminal = true;
    await interruptLiveApproval();
    bridge.fail(
      "Codex App Server ended before the diagnostic turn completed. Resume the Root-managed diagnostic session to continue safely.",
    );
    await dispose();
  };

  const scheduleTurnEvent = (action: () => Promise<void>): Promise<void> => {
    if (!turnReady) {
      pendingTurnEvents.push(action);
      return Promise.resolve();
    }
    eventChain = eventChain
      .then(action)
      .catch(() => failForInterruptedProcess());
    return eventChain;
  };

  const isCurrentTurn = (value: unknown): value is Record<string, unknown> =>
    isRecord(value) &&
    value.threadId === threadId &&
    typeof value.turnId === "string" &&
    value.turnId === turnId;

  const isPendingOrCurrentTurn = (
    value: unknown,
  ): value is Record<string, unknown> =>
    isRecord(value) &&
    value.threadId === threadId &&
    typeof value.turnId === "string" &&
    (!turnReady || value.turnId === turnId);

  const settleApproval = async (
    requestKey: string,
    decision: "approve" | "deny",
  ): Promise<void> => {
    const live = approvals.get(requestKey);
    if (!live) {
      return;
    }
    approvals.delete(requestKey);
    const effectiveDecision = live.kind === "permissions" ? "deny" : decision;
    await live.registration.resolve({ decision: effectiveDecision });
  };

  const registerServerApproval = async (
    request: CodexAppServerServerRequest,
  ): Promise<void> => {
    if (!broker || !binding || terminal) {
      respondUnsupportedServerRequest(process, request);
      return;
    }
    const normalized = normalizeApprovalRequest(
      request,
      binding,
      threadId,
      turnId,
    );
    if (!normalized) {
      respondUnsupportedServerRequest(process, request);
      return;
    }
    const registered = await broker.register({
      request: normalized.request,
      async respond(response) {
        // A broker decision is mapped to the narrowest current App Server
        // response. It never grants session-wide policy amendments or sends
        // raw request content into Eve or the durable workpad.
        if (normalized.kind === "permissions") {
          process.respond(request.id, { scope: "turn", permissions: {} });
          return;
        }
        process.respond(request.id, {
          decision: response.decision === "approve" ? "accept" : "decline",
        });
      },
    });
    if (registered.status !== "registered") {
      return;
    }
    approvals.set(normalized.request_key, {
      registration: registered,
      item_id: normalized.item_id,
      kind: normalized.kind,
    });
  };

  const recordAutoReviewTerminal = async (
    notification: CodexAppServerNotification,
  ): Promise<void> => {
    if (!broker || !binding || !isCurrentTurn(notification.params)) {
      return;
    }
    const params = notification.params;
    if (!isRecord(params.review) || typeof params.review.status !== "string") {
      return;
    }
    const status = params.review.status;
    if (!["approved", "denied", "timedOut", "aborted"].includes(status)) {
      return;
    }
    const itemId =
      typeof params.targetItemId === "string" ? params.targetItemId : undefined;
    const matching = [...approvals.entries()].find(
      ([, live]) => live.item_id !== undefined && live.item_id === itemId,
    );
    if (matching) {
      await settleApproval(
        matching[0],
        status === "approved" ? "approve" : "deny",
      );
      return;
    }
    if (typeof params.reviewId !== "string" || !isSafeIdentifier(turnId)) {
      return;
    }

    // Current Codex versions can resolve auto-review internally without ever
    // sending a client request. Preserve only its terminal decision while the
    // live process and turn still exist; the opaque review id remains memory-only.
    const kind = autoReviewKind(params.action);
    const registered = await broker.register({
      request: {
        provider_request_id: "auto-review/" + params.reviewId,
        kind,
        turn_id: turnId,
        session: binding,
      },
      async respond() {
        // Codex already consumed this auto-review decision internally.
      },
    });
    if (registered.status === "registered") {
      await registered.resolve({
        decision:
          status === "approved" && kind !== "permissions" ? "approve" : "deny",
      });
    }
  };

  const handleNotification = async (
    notification: CodexAppServerNotification,
  ): Promise<void> => {
    if (terminal) {
      return;
    }
    if (notification.method === "serverRequest/resolved") {
      if (
        !isRecord(notification.params) ||
        notification.params.threadId !== threadId
      ) {
        return;
      }
      const requestId = notification.params.requestId;
      if (!isRequestId(requestId)) {
        return;
      }
      const key = requestIdKey(requestId);
      return scheduleTurnEvent(async () => {
        const live = approvals.get(key);
        if (!live) {
          return;
        }
        approvals.delete(key);
        await live.registration.cancel();
      });
    }
    if (notification.method === "item/autoApprovalReview/completed") {
      return scheduleTurnEvent(() => recordAutoReviewTerminal(notification));
    }
    if (notification.method === "item/agentMessage/delta") {
      const params = notification.params;
      if (!isPendingOrCurrentTurn(params)) {
        return;
      }
      return scheduleTurnEvent(async () => {
        if (!isCurrentTurn(params) || typeof params.delta !== "string") {
          return;
        }
        bridge.textDelta(params.delta);
      });
    }
    if (notification.method === "item/completed") {
      const params = notification.params;
      if (!isPendingOrCurrentTurn(params)) {
        return;
      }
      return scheduleTurnEvent(async () => {
        if (!isCurrentTurn(params) || !isRecord(params.item)) {
          return;
        }
        const item = params.item;
        if (item.type !== "agentMessage" || typeof item.text !== "string") {
          return;
        }
        bridge.textFallback(item.text);
      });
    }
    if (notification.method === "turn/completed") {
      if (
        !isRecord(notification.params) ||
        notification.params.threadId !== threadId
      ) {
        return;
      }
      const turn = notification.params.turn;
      if (
        !isRecord(turn) ||
        typeof turn.id !== "string" ||
        typeof turn.status !== "string"
      ) {
        return;
      }
      const status = turn.status;
      return scheduleTurnEvent(async () => {
        // App Server can publish events before its `turn/start` response.
        // Recheck after the response binds this live transport to one turn.
        if (terminal || turn.id !== turnId) {
          return;
        }
        terminal = true;
        await interruptLiveApproval();
        try {
          await options.workpad.recordCompletion(
            options.envelope,
            threadId,
            undefined,
            status,
          );
        } catch {
          bridge.fail(
            "Codex diagnostic completion could not be journaled safely. Resume the Root-managed diagnostic session before continuing.",
          );
          await dispose();
          return;
        }
        bridge.finish(threadId, turnId, status);
        await dispose();
      });
    }
  };

  try {
    unsubscribers.push(process.onClose(() => failForInterruptedProcess()));
    unsubscribers.push(process.onNotification(handleNotification));

    await process.request("initialize", {
      clientInfo: {
        name: "failure-report-diagnostic-host",
        title: "FailureReport diagnostic host",
        version: "1.0.0",
      },
    });
    process.notify("initialized", {});

    const persistedThreadId = loaded.diagnostic_session.state.codex_thread_id;
    const threadResponse = await process.request(
      persistedThreadId ? "thread/resume" : "thread/start",
      persistedThreadId
        ? resumeThreadParams(
            options.config,
            cwd,
            persistedThreadId,
            prompt.system,
          )
        : startThreadParams(options.config, cwd, prompt.system),
    );
    threadId = readThreadId(threadResponse);
    if (persistedThreadId && threadId !== persistedThreadId) {
      throw new Error(
        "Codex App Server returned a different persistent thread for the Root-owned diagnostic session.",
      );
    }
    assertThreadSettings(threadResponse, cwd);
    await options.workpad.recordThread(options.envelope, threadId);
    binding = await options.workpad.loadNativeApprovalSessionBinding(
      options.envelope,
    );
    broker = await options.create_approval_broker({
      workpad: options.workpad,
      envelope: options.envelope,
    });
    unsubscribers.push(
      process.onServerRequest((request) => {
        const params = request.params;
        if (!isRecord(params) || params.threadId !== threadId) {
          respondUnsupportedServerRequest(process, request);
          return;
        }
        const requestTurnId = params.turnId;
        if (typeof requestTurnId !== "string") {
          respondUnsupportedServerRequest(process, request);
          return;
        }
        return scheduleTurnEvent(() => registerServerApproval(request));
      }),
    );

    const turnResponse = await process.request(
      "turn/start",
      turnStartParams(options.config, cwd, threadId, prompt),
    );
    turnId = readTurnId(turnResponse);
    bridge.start(prompt.warnings, threadId, turnId, options.config.model);
    turnReady = true;
    for (const pending of pendingTurnEvents.splice(0)) {
      scheduleTurnEvent(pending);
    }

    abortSignal = readAbortSignal(callOptions);
    const interrupt = async (): Promise<void> => {
      if (terminal) {
        return;
      }
      try {
        await process.request("turn/interrupt", { threadId, turnId });
      } catch {
        // A failed interrupt is indistinguishable from a lost live transport;
        // terminal broker evidence is safer than leaving the request pending.
      }
      await failForInterruptedProcess();
    };
    abortHandler = () => {
      void interrupt();
    };
    bridge.setCancel(interrupt);
    if (abortSignal) {
      if (abortSignal.aborted) {
        void interrupt();
      } else {
        abortSignal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    return { stream: bridge.stream };
  } catch (error) {
    terminal = true;
    await interruptLiveApproval();
    await dispose();
    throw error;
  }
}

/** Builds the required thread settings for both new and resumed diagnostics. */
function baseThreadParams(config: CodexAppServerBackendConfig, cwd: string) {
  return {
    model: config.model,
    cwd,
    approvalPolicy: config.approval_mode,
    approvalsReviewer: config.approvals_reviewer,
    sandbox: config.sandbox_mode,
  };
}

function startThreadParams(
  config: CodexAppServerBackendConfig,
  cwd: string,
  systemInstructions: string | undefined,
) {
  return {
    ...baseThreadParams(config, cwd),
    developerInstructions: developerInstructions(systemInstructions),
  };
}

function resumeThreadParams(
  config: CodexAppServerBackendConfig,
  cwd: string,
  threadId: string,
  systemInstructions: string | undefined,
) {
  return {
    threadId,
    ...baseThreadParams(config, cwd),
    developerInstructions: developerInstructions(systemInstructions),
  };
}

/** Adds an invariant developer instruction on new and resumed persistent threads. */
function developerInstructions(systemInstructions: string | undefined): string {
  return [systemInstructions, directDiagnosticBoundaryInstructions]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

/** Uses thread-level workspace-write settings rather than broadening turn roots. */
function turnStartParams(
  config: CodexAppServerBackendConfig,
  cwd: string,
  threadId: string,
  prompt: ExtractedPrompt,
) {
  return {
    threadId,
    input: prompt.inputs,
    cwd,
    approvalPolicy: config.approval_mode,
    approvalsReviewer: config.approvals_reviewer,
    model: config.model,
    effort: config.reasoning_effort,
    ...(prompt.output_schema ? { outputSchema: prompt.output_schema } : {}),
  };
}

type ExtractedPrompt = {
  inputs: Array<Record<string, unknown>>;
  system: string | undefined;
  warnings: Array<Record<string, unknown>>;
  output_schema: unknown;
};

/**
 * Reduces AI SDK prompt state to the latest user inputs accepted by the native
 * Codex thread. Assistant/tool history is already owned by the persistent
 * App Server thread, so passing it back would duplicate or expose Eve traffic.
 */
function extractPrompt(callOptions: unknown): ExtractedPrompt {
  const options = isRecord(callOptions) ? callOptions : {};
  const prompt = Array.isArray(options.prompt) ? options.prompt : [];
  const warnings: Array<Record<string, unknown>> = [];
  const systems: string[] = [];
  for (const message of prompt) {
    if (
      isRecord(message) &&
      message.role === "system" &&
      typeof message.content === "string"
    ) {
      systems.push(message.content);
    }
  }

  const userMessages: Array<Record<string, unknown>> = [];
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index];
    if (!isRecord(message)) {
      continue;
    }
    if (message.role === "user") {
      userMessages.push(message);
    } else if (userMessages.length > 0) {
      break;
    }
  }
  if (userMessages.length === 0) {
    for (let index = prompt.length - 1; index >= 0; index -= 1) {
      const message = prompt[index];
      if (isRecord(message) && message.role === "user") {
        userMessages.push(message);
        break;
      }
    }
  }

  const inputs: Array<Record<string, unknown>> = [];
  for (const message of userMessages.reverse()) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (!isRecord(part)) {
        continue;
      }
      if (part.type === "text" && typeof part.text === "string") {
        inputs.push({ type: "text", text: part.text });
      } else if (part.type === "file") {
        const image = toNativeImageInput(part);
        if (image) {
          inputs.push(image);
        } else {
          warnings.push({
            type: "other",
            message:
              "A non-native image input was omitted from the Codex diagnostic turn.",
          });
        }
      }
    }
  }
  if (inputs.length === 0) {
    warnings.push({
      type: "other",
      message: "No user text was available for the Codex diagnostic turn.",
    });
  }

  const outputSchema =
    isRecord(options.responseFormat) &&
    options.responseFormat.type === "json" &&
    "schema" in options.responseFormat
      ? options.responseFormat.schema
      : undefined;
  return {
    inputs,
    system: systems.length > 0 ? systems.join("\n\n") : undefined,
    warnings,
    output_schema: outputSchema,
  };
}

/** Supports only native file or URL image inputs; no temporary prompt files are created. */
function toNativeImageInput(
  part: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    typeof part.mediaType !== "string" ||
    !part.mediaType.startsWith("image/")
  ) {
    return undefined;
  }
  const data = part.data;
  const value = data instanceof URL ? data.href : data;
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.startsWith("file:")) {
    try {
      return { type: "localImage", path: new URL(value).pathname };
    } catch {
      return undefined;
    }
  }
  if (/^(?:https?:|data:)/i.test(value)) {
    return { type: "image", imageUrl: value };
  }
  return undefined;
}

type NormalizedApproval = {
  request_key: string;
  item_id: string;
  kind: NativeApprovalRequestKind;
  request: {
    provider_request_id: string;
    kind: NativeApprovalRequestKind;
    turn_id: string;
    session: NativeApprovalSessionBinding;
  };
};

/**
 * Maps only the stable identity fields required by the broker. Approval bodies,
 * command text, paths, arguments, permissions, and opaque ids never enter the
 * Eve model stream or the durable workpad.
 */
function normalizeApprovalRequest(
  request: CodexAppServerServerRequest,
  binding: NativeApprovalSessionBinding,
  threadId: string,
  turnId: string,
): NormalizedApproval | undefined {
  if (!isRecord(request.params)) {
    return undefined;
  }
  const params = request.params;
  if (
    params.threadId !== threadId ||
    params.turnId !== turnId ||
    typeof params.itemId !== "string" ||
    !isSafeIdentifier(turnId) ||
    !isRequestId(request.id)
  ) {
    return undefined;
  }
  const kind =
    request.method === "item/commandExecution/requestApproval"
      ? "command_execution"
      : request.method === "item/fileChange/requestApproval"
        ? "file_change"
        : request.method === "item/permissions/requestApproval"
          ? "permissions"
          : undefined;
  if (!kind) {
    return undefined;
  }
  const requestKey = requestIdKey(request.id);
  if (requestKey.length > 1_024) {
    return undefined;
  }
  return {
    request_key: requestKey,
    item_id: params.itemId,
    kind,
    request: {
      provider_request_id: requestKey,
      kind,
      turn_id: turnId,
      session: binding,
    },
  };
}

/** Converts a transient auto-review action type to the broker's safe taxonomy. */
function autoReviewKind(value: unknown): NativeApprovalRequestKind {
  if (!isRecord(value) || typeof value.type !== "string") {
    return "other";
  }
  if (
    value.type === "command" ||
    value.type === "execve" ||
    value.type === "networkAccess"
  ) {
    return "command_execution";
  }
  if (value.type === "applyPatch") {
    return "file_change";
  }
  if (value.type === "requestPermissions") {
    return "permissions";
  }
  return "other";
}

/** Unknown native server requests are denied inside the connection, never via Eve. */
function respondUnsupportedServerRequest(
  process: DirectCodexAppServerProcess,
  request: CodexAppServerServerRequest,
): void {
  try {
    process.respondError(
      request.id,
      -32601,
      "FailureReport does not expose this Codex-native request to Eve.",
    );
  } catch {
    // A closed process is handled by the transport-close interrupt path.
  }
}

/** Ensures the App Server did not rebind this model to an arbitrary thread. */
function readThreadId(response: unknown): string {
  if (
    !isRecord(response) ||
    !isRecord(response.thread) ||
    !isSafeIdentifier(response.thread.id)
  ) {
    throw new Error(
      "Codex App Server did not return a safe persistent thread id.",
    );
  }
  return response.thread.id;
}

/** Verifies the process echoed the Root-owned worktree and native approval mode. */
function assertThreadSettings(response: unknown, cwd: string): void {
  if (!isRecord(response)) {
    throw new Error("Codex App Server returned an invalid thread response.");
  }
  if (response.cwd !== cwd) {
    throw new Error(
      "Codex App Server did not retain the Root-owned diagnostic worktree.",
    );
  }
  if (
    response.approvalPolicy !== "on-request" ||
    response.approvalsReviewer !== "auto_review"
  ) {
    throw new Error(
      "Codex App Server did not retain native on-request auto-review settings.",
    );
  }
  if (!isWorkspaceWriteSandbox(response.sandbox)) {
    throw new Error(
      "Codex App Server did not retain the workspace-write diagnostic sandbox.",
    );
  }
}

/** Accepts the current structured response and the legacy mode spelling. */
function isWorkspaceWriteSandbox(value: unknown): boolean {
  return (
    value === "workspace-write" ||
    (isRecord(value) && value.type === "workspaceWrite")
  );
}

function readTurnId(response: unknown): string {
  if (
    !isRecord(response) ||
    !isRecord(response.turn) ||
    !isSafeIdentifier(response.turn.id)
  ) {
    throw new Error(
      "Codex App Server did not return a safe diagnostic turn id.",
    );
  }
  return response.turn.id;
}

function readAbortSignal(value: unknown): AbortSignal | undefined {
  if (!isRecord(value) || !isRecord(value.abortSignal)) {
    return undefined;
  }
  const signal = value.abortSignal;
  return typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function"
    ? (signal as unknown as AbortSignal)
    : undefined;
}

type StreamBridge = {
  stream: ReadableStream<unknown>;
  start(
    warnings: readonly Record<string, unknown>[],
    threadId: string,
    turnId: string,
    modelId: string,
  ): void;
  textDelta(delta: string): void;
  textFallback(text: string): void;
  finish(threadId: string, turnId: string, status: string): void;
  fail(message: string): void;
  setCancel(handler: () => Promise<void>): void;
};

/**
 * Converts only agent-message events into AI SDK stream parts. Codex-native
 * commands, file changes, approval bodies, and raw events stay in the direct
 * App Server boundary so Eve cannot schedule another worker turn from them.
 */
function createStreamBridge(): StreamBridge {
  let controller: ReadableStreamDefaultController<unknown> | undefined;
  let cancelled: (() => Promise<void>) | undefined;
  let started = false;
  let terminal = false;
  let textStarted = false;
  let textEmitted = false;
  const textId = "codex-text-" + randomUUID();
  const stream = new ReadableStream<unknown>({
    start(current) {
      controller = current;
    },
    cancel() {
      return cancelled?.();
    },
  });

  const enqueue = (part: unknown): void => {
    if (controller && !terminal) {
      controller.enqueue(part);
    }
  };
  const beginText = (): void => {
    if (!textStarted) {
      textStarted = true;
      enqueue({ type: "text-start", id: textId });
    }
  };
  const close = (): void => {
    if (terminal) {
      return;
    }
    terminal = true;
    controller?.close();
  };

  return {
    stream,
    start(warnings, _threadId, turnId, modelId) {
      if (started || terminal) {
        return;
      }
      started = true;
      enqueue({ type: "stream-start", warnings: [...warnings] });
      enqueue({
        type: "response-metadata",
        id: turnId,
        timestamp: new Date(),
        modelId,
      });
    },
    textDelta(delta) {
      if (!started || terminal || !delta) {
        return;
      }
      beginText();
      textEmitted = true;
      enqueue({ type: "text-delta", id: textId, delta });
    },
    textFallback(text) {
      if (!started || terminal || textEmitted || !text) {
        return;
      }
      beginText();
      textEmitted = true;
      enqueue({ type: "text-delta", id: textId, delta: text });
    },
    finish(threadId, turnId, status) {
      if (!started || terminal) {
        return;
      }
      if (textStarted) {
        enqueue({ type: "text-end", id: textId });
      }
      enqueue({
        type: "finish",
        finishReason: {
          unified: status === "failed" ? "error" : "stop",
          raw: status,
        },
        usage: emptyUsage(),
        providerMetadata: { codex: { sessionId: threadId, turnId } },
      });
      close();
    },
    fail(message) {
      if (terminal) {
        return;
      }
      if (!started) {
        return;
      }
      enqueue({ type: "error", error: new Error(message) });
      enqueue({
        type: "finish",
        finishReason: { unified: "error", raw: "interrupted" },
        usage: emptyUsage(),
      });
      close();
    },
    setCancel(handler) {
      cancelled = handler;
    },
  };
}

function emptyUsage() {
  return {
    inputTokens: { total: 0 },
    outputTokens: { total: 0 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRequestId(value: unknown): value is CodexAppServerRequestId {
  return typeof value === "string" || typeof value === "number";
}

function requestIdKey(id: CodexAppServerRequestId): string {
  return typeof id + ":" + String(id);
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)
  );
}
