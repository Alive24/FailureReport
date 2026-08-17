import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  rootRequestSchema,
  rootResultSchema,
  type RootRequest,
  type RootInvoker,
  type RootResult,
} from "@failure-report/protocol";

import {
  createMcpRootInvoker,
  defaultRootSessionStorePath,
  type RootOperationRetentionOptions,
} from "./eve-channel-root-invoker.js";
import {
  FileRootSessionStore,
  type RootOperationStore,
} from "./root-operation-store.js";
import {
  readRuntimeSupervisorConfig,
  RuntimeSupervisedRootInvoker,
  RuntimeSupervisor,
  type RuntimeSupervisorDependencies,
} from "./runtime-supervisor.js";

export {
  buildRootInvocationMessage,
  createMcpRootInvoker,
  defaultRootSessionStorePath,
  EveChannelRootInvoker,
  EveChannelRootTransport,
  FileRootSessionStore,
  InMemoryRootSessionStore,
  rootSessionKey,
  type EveChannelRootTransportOptions,
  type EveChannelRootTurn,
  type EveChannelRootPendingTurnConsumer,
  type McpRootCompositionOptions,
  type RootOperationRetentionOptions,
  type RootOperationStore,
  type RootSessionOperationLedger,
  type RootSessionStore,
} from "./eve-channel-root-invoker.js";
export {
  readRuntimeSupervisorConfig,
  rootRequestRepository,
  RuntimeSupervisedRootInvoker,
  RuntimeSupervisor,
  RuntimeSupervisorError,
  type RuntimeSupervisorConfig,
  type RuntimeSupervisorDependencies,
  type RuntimeSupervisorFailureCategory,
  type RuntimeSupervisorMode,
  type TrustedRepositoryProvisioning,
} from "./runtime-supervisor.js";

export type SupervisedMcpRootCompositionOptions = {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  session_store?: RootOperationStore;
  session_store_path?: string;
  operation_retention?: RootOperationRetentionOptions;
  supervisor?: RuntimeSupervisor;
  supervisor_dependencies?: RuntimeSupervisorDependencies;
};

/** Creates the production stdio composition with readiness before Root delivery. */
export function createSupervisedMcpRootInvoker(
  options: SupervisedMcpRootCompositionOptions = {},
): RuntimeSupervisedRootInvoker {
  const environment = options.environment ?? process.env;
  const config = readRuntimeSupervisorConfig(environment, options.cwd);
  const store =
    options.session_store ??
    new FileRootSessionStore(
      options.session_store_path ?? defaultRootSessionStorePath(environment),
    );
  const core = createMcpRootInvoker({
    host: config.host,
    ...(config.bearer ? { bearer: config.bearer } : {}),
    session_store: store,
    operation_retention: options.operation_retention,
  });
  return new RuntimeSupervisedRootInvoker(
    core,
    options.supervisor ??
      new RuntimeSupervisor(config, options.supervisor_dependencies),
    store,
  );
}

/**
 * MCP adapter for the public Root contract.
 *
 * This package deliberately exposes one tool only. Domain packs remain an
 * implementation detail selected by Root and never become an MCP API surface.
 */

/** Validated function shape used by the MCP tool handler and unit tests. */
export type RootRequestHandler = (request: RootRequest) => Promise<RootResult>;

/**
 * Wraps a Root invoker with inbound and outbound protocol validation.
 * Validation at both edges prevents a transport implementation from widening the
 * public contract accidentally.
 */
export function createRootRequestHandler(
  invoker: RootInvoker,
): RootRequestHandler {
  return async (request) => {
    const parsedRequest = rootRequestSchema.parse(request);
    return rootResultSchema.parse(await invoker.invoke(parsedRequest));
  };
}

/** Creates the in-process MCP server exposing the single `failure_report` tool. */
export function createFailureReportMcpServer(invoker: RootInvoker): McpServer {
  const handle = createRootRequestHandler(invoker);
  const server = new McpServer({
    name: "failure-report",
    version: "0.1.0",
  });

  server.registerTool(
    "failure_report",
    {
      title: "FailureReport Root",
      description:
        "Invoke the public FailureReport Root for intake, resume, inspection, or handoff rendering.",
      inputSchema: rootRequestSchema,
      outputSchema: rootResultSchema,
    },
    async (request) => {
      try {
        const result = await handle(request);
        return {
          structuredContent: result,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        // MCP tool errors are returned as tool content so the caller receives a
        // structured protocol response rather than a dropped stdio connection.
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: message,
            },
          ],
        };
      }
    },
  );

  return server;
}

/** Connects the public MCP server to the process's standard input/output stream. */
export async function runFailureReportMcpServer(
  invoker: RootInvoker,
): Promise<void> {
  if (hasPendingOperationRecovery(invoker)) {
    await invoker.resumePendingOperations();
  }
  const server = createFailureReportMcpServer(invoker);
  await server.connect(new StdioServerTransport());
}

function hasPendingOperationRecovery(
  invoker: RootInvoker,
): invoker is RootInvoker & { resumePendingOperations(): Promise<void> } {
  return (
    "resumePendingOperations" in invoker &&
    typeof invoker.resumePendingOperations === "function"
  );
}
