import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  rootRequestSchema,
  rootResultSchema,
  type RootRequest,
  type RootResult,
} from "@failure-report/protocol";
import type { RootInvoker } from "@failure-report/runtime-port";

export type RootRequestHandler = (request: RootRequest) => Promise<RootResult>;

export function createRootRequestHandler(
  invoker: RootInvoker,
): RootRequestHandler {
  return async (request) => {
    const parsedRequest = rootRequestSchema.parse(request);
    return rootResultSchema.parse(await invoker.invoke(parsedRequest));
  };
}

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

export async function runFailureReportMcpServer(
  invoker: RootInvoker,
): Promise<void> {
  const server = createFailureReportMcpServer(invoker);
  await server.connect(new StdioServerTransport());
}
