import { runFailureReportMcpServer } from "@failure-report/mcp-adapter";

import {
  EveHttpRootTransport,
  EveRootInvoker,
  InMemoryRootSessionStore,
} from "./eve-root-invoker.js";

const host = process.env.FAILURE_REPORT_EVE_HOST ?? "http://127.0.0.1:3000";
const bearer = process.env.FAILURE_REPORT_EVE_BEARER_TOKEN;
const transport = new EveHttpRootTransport({
  host,
  ...(bearer ? { auth: { bearer } } : {}),
});
const invoker = new EveRootInvoker(transport, new InMemoryRootSessionStore());

await runFailureReportMcpServer(invoker);
