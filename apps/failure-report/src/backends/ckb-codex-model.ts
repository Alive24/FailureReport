import type { LanguageModel, ModelMessage } from "ai";
import {
  createCodexAppServer,
  type CodexAppServerLanguageModel,
} from "ai-sdk-provider-codex-app-server";

import type { CkbBackendConfig } from "../backend-config.js";
import {
  parseCkbExecutionEnvelope,
  type CkbExecutionEnvelope,
} from "../execution/ckb-envelope.js";
import { CkbExecutionWorkpad } from "../execution/ckb-workpad.js";
import { CkbWorktreeManager } from "../execution/ckb-worktree.js";

type CkbProviderFactory = typeof createCodexAppServer;
type CodexStreamOptions = Parameters<
  CodexAppServerLanguageModel["doStream"]
>[0];
type CodexGenerateOptions = Parameters<
  CodexAppServerLanguageModel["doGenerate"]
>[0];

export type CkbCodexModelFactoryDependencies = {
  execution_workpad?: CkbExecutionWorkpad;
  create_provider?: CkbProviderFactory;
};

export function createCkbExecutionWorkpad(
  config: CkbBackendConfig,
): CkbExecutionWorkpad {
  return new CkbExecutionWorkpad({
    worktrees: new CkbWorktreeManager({ root: config.worktree_root }),
  });
}

export function createCkbCodexModelResolver(
  config: CkbBackendConfig,
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

export function createBlockedCkbModel(): LanguageModel {
  const blocked = async (): Promise<never> => {
    throw new Error(
      "CKB may only run through a Root-prepared Codex App-server execution envelope.",
    );
  };

  // Eve requires a static dynamic-model fallback. This guard can never select a
  // workspace, so a malformed or missing envelope cannot reach a canonical checkout.
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

async function createCkbCodexModel(
  envelope: CkbExecutionEnvelope,
  config: CkbBackendConfig,
  workpad: CkbExecutionWorkpad,
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

  // ai-sdk-provider-codex-app-server is currently LanguageModelV3-based while
  // Eve resolves AI SDK v7's LanguageModel union. The v3 surface is compatible
  // at runtime; keep the version boundary contained in this backend factory.
  return model as unknown as LanguageModel;
}

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

function isFinishPart(value: unknown): boolean {
  return isRecord(value) && value.type === "finish";
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
