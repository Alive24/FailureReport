import { createMcpRootInvoker, runFailureReportMcpServer } from "./index.js";

/**
 * Local MCP process entry point.
 * Environment variables override only the Eve endpoint/authentication; the public
 * surface always remains the one-tool MCP wrapper over Eve's default Channel.
 */
const invoker = createMcpRootInvoker({
  host: process.env.FAILURE_REPORT_EVE_HOST,
  bearer: process.env.FAILURE_REPORT_EVE_BEARER_TOKEN,
});

await runFailureReportMcpServer(invoker);
