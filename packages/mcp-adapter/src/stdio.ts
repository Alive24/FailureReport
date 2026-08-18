import {
  createSupervisedMcpRootInvoker,
  runFailureReportMcpServer,
} from "./index.js";

/**
 * Local MCP process entry point.
 * Environment variables select only private runtime supervision and Channel
 * authentication; the public surface remains the one-tool Root wrapper.
 */
const invoker = createSupervisedMcpRootInvoker();

await runFailureReportMcpServer(invoker);
