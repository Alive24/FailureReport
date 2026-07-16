import { runFailureReportMcpServer } from "@failure-report/mcp-adapter";

import { createMcpRootInvoker } from "./mcp-composition.js";

/**
 * Local MCP process entry point.
 * Environment variables override only the Eve endpoint/authentication; the public
 * surface always remains the Root-only MCP adapter.
 */
const invoker = createMcpRootInvoker({
  host: process.env.FAILURE_REPORT_EVE_HOST,
  bearer: process.env.FAILURE_REPORT_EVE_BEARER_TOKEN,
});

await runFailureReportMcpServer(invoker);
