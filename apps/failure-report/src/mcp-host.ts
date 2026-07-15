import { runFailureReportMcpServer } from "@failure-report/mcp-adapter";

import { createMcpRootInvoker } from "./mcp-composition.js";

const invoker = createMcpRootInvoker({
  host: process.env.FAILURE_REPORT_EVE_HOST,
  bearer: process.env.FAILURE_REPORT_EVE_BEARER_TOKEN,
});

await runFailureReportMcpServer(invoker);
