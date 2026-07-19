import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  rootRequestSchema,
  rootResultSchema,
  type RootRequest,
  type RootInvoker,
  type RootResult,
} from "@failure-report/protocol";

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
  type RootSessionStore,
} from "./eve-channel-root-invoker.js";

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
        "Invoke the public FailureReport Root for intake, resume, inspection, approval results, or handoff rendering.",
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
  const server = createFailureReportMcpServer(invoker);
  await server.connect(new StdioServerTransport());
}
