import type { LanguageModel, ModelMessage } from "ai";
import {
  createCodexAppServer,
  type CodexAppServerLanguageModel,
} from "ai-sdk-provider-codex-app-server";

import type { ExecutionWorkpad } from "../../execution/workpad.js";
import type { CkbCodexBackendConfig } from "./config.js";
import {
  createCkbExecutionWorkpad,
  parseCkbExecutionEnvelope,
  type CkbExecutionEnvelope,
} from "./execution.js";

/**
 * CKB-specific adapter from Eve's dynamic model hook to Codex App-server.
 *
 * The adapter owns provider/session persistence for this domain only; generic
 * worktree safety and durable Issue workpad behavior stay in `src/execution`.
 */

type CkbProviderFactory = typeof createCodexAppServer;
type CodexStreamOptions = Parameters<
  CodexAppServerLanguageModel["doStream"]
>[0];
type CodexGenerateOptions = Parameters<
  CodexAppServerLanguageModel["doGenerate"]
>[0];

/** Test seams for the CKB model factory; production uses the real provider/workpad. */
export type CkbCodexModelFactoryDependencies = {
  execution_workpad?: ExecutionWorkpad;
  create_provider?: CkbProviderFactory;
};

/**
 * Builds Eve's dynamic model resolver for the CKB subagent.
 * The resolver derives the provider only from a validated Root delegation message.
 */
export function createCkbCodexModelResolver(
  config: CkbCodexBackendConfig,
  dependencies: CkbCodexModelFactoryDependencies = {},
): (messages: readonly ModelMessage[]) => Promise<{
  model: LanguageModel;
  modelContextWindowTokens: number;
}> {
  const workpad =
    dependencies.execution_workpad ?? createCkbExecutionWorkpad(config);
  const createProvider = dependencies.create_provider ?? createCodexAppServer;

  return async (messages) => {
    const envelope = parseCkbExecutionEnvelope(messages);
    return {
      model: await createCkbCodexModel(
        envelope,
        config,
        workpad,
        createProvider,
      ),
      modelContextWindowTokens: config.model_context_window_tokens,
    };
  };
}

/**
 * Creates a fail-closed fallback required by Eve's dynamic-model API.
 * It cannot select a worktree or launch Codex, so a malformed message stays safe.
 */
export function createBlockedCkbModel(): LanguageModel {
  const blocked = async (): Promise<never> => {
    throw new Error(
      "CKB may only run through a Root-prepared Codex App-server execution envelope.",
    );
  };

  return {
    specificationVersion: "v3",
    provider: "failure-report-guard",
    modelId: "ckb-execution-required",
    supportedUrls: {},
    defaultObjectGenerationMode: "json",
    supportsStructuredOutputs: true,
    supportsImageUrls: false,
    doGenerate: blocked,
    doStream: blocked,
  } as unknown as LanguageModel;
}

/**
 * Creates one persistent Codex provider bound to the workpad-validated worktree.
 * Thread creation and completion are journaled so a later Root invocation can
 * resume the same Codex conversation instead of creating an untracked one.
 */
async function createCkbCodexModel(
  envelope: CkbExecutionEnvelope,
  config: CkbCodexBackendConfig,
  workpad: ExecutionWorkpad,
  createProvider: CkbProviderFactory,
): Promise<LanguageModel> {
  const loaded = await workpad.loadForExecution(envelope);
  let threadId = loaded.execution.state.codex_thread_id;
  let pendingThreadPersistence: Promise<void> | undefined;
  let persistenceError: unknown;

  const provider = createProvider({
    defaultSettings: {
      codexPath: config.codex_path,
      cwd: loaded.execution.state.worktree.path,
      approvalMode: config.approval_mode,
      sandboxMode: config.sandbox_mode,
      reasoningEffort: config.reasoning_effort,
      threadMode: "persistent",
      ...(threadId ? { resume: threadId } : {}),
      onSessionCreated(session) {
        threadId = session.threadId;
        // Persist immediately rather than waiting for a streamed answer: a process
        // interruption after session creation must still leave a resumable thread.
        pendingThreadPersistence = workpad
          .recordThread(envelope, session.threadId)
          .then(() => undefined)
          .catch((error: unknown) => {
            persistenceError = error;
          });
      },
    },
  });
  const rawModel = provider(config.model);

  const journal = {
    async ensureThread(): Promise<string> {
      if (!pendingThreadPersistence || !threadId) {
        throw new Error(
          "Codex App-server did not expose a persistent CKB thread id.",
        );
      }
      await pendingThreadPersistence;
      if (persistenceError) {
        throw persistenceError;
      }
      return threadId;
    },
    async complete(metadataThreadId?: string): Promise<void> {
      const persistedThreadId = metadataThreadId ?? (await this.ensureThread());
      await workpad.recordCompletion(envelope, persistedThreadId);
    },
  };

  return trackCodexModel(rawModel, journal);
}

/**
 * Wraps Codex's model so durable thread and worktree state is saved at lifecycle
 * boundaries without exposing GitHub-writing tools to the model itself.
 */
function trackCodexModel(
  rawModel: CodexAppServerLanguageModel,
  journal: {
    ensureThread(): Promise<string>;
    complete(metadataThreadId?: string): Promise<void>;
  },
): LanguageModel {
  const model = {
    specificationVersion: rawModel.specificationVersion,
    provider: rawModel.provider,
    modelId: rawModel.modelId,
    supportedUrls: rawModel.supportedUrls,
    defaultObjectGenerationMode: rawModel.defaultObjectGenerationMode,
    supportsStructuredOutputs: rawModel.supportsStructuredOutputs,
    supportsImageUrls: rawModel.supportsImageUrls,
    async doStream(options: CodexStreamOptions) {
      const result = await rawModel.doStream(options);
      await journal.ensureThread();
      return {
        ...result,
        stream: persistAfterFinish(result.stream, journal),
      };
    },
    async doGenerate(options: CodexGenerateOptions) {
      const result = await rawModel.doGenerate(options);
      await journal.ensureThread();
      await journal.complete();
      return result;
    },
  };

  // The community provider exposes LanguageModelV3 while Eve currently accepts
  // AI SDK v7's union. Contain this runtime-compatible boundary in the adapter.
  return model as unknown as LanguageModel;
}

/**
 * Mirrors a streaming response and persists completion exactly once.
 * A provider may emit a finish part before the reader reports `done`, so both
 * paths share the same idempotent completion guard.
 */
function persistAfterFinish<T>(
  stream: ReadableStream<T>,
  journal: {
    complete(metadataThreadId?: string): Promise<void>;
  },
): ReadableStream<T> {
  const reader = stream.getReader();
  let completed = false;

  const persistCompletion = async (part?: T): Promise<void> => {
    if (completed) {
      return;
    }
    completed = true;
    await journal.complete(readThreadIdFromProviderMetadata(part));
  };

  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await persistCompletion();
          controller.close();
          return;
        }
        if (isFinishPart(next.value)) {
          await persistCompletion(next.value);
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/** Identifies the provider stream part that carries final completion metadata. */
function isFinishPart(value: unknown): boolean {
  return isRecord(value) && value.type === "finish";
}

/** Extracts the optional session id from the Codex provider's finish metadata. */
function readThreadIdFromProviderMetadata(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.providerMetadata)) {
    return undefined;
  }
  const codex = value.providerMetadata.codex;
  if (!isRecord(codex) || typeof codex.sessionId !== "string") {
    return undefined;
  }
  return codex.sessionId;
}

/** Narrows unknown provider metadata before accessing its nested fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
