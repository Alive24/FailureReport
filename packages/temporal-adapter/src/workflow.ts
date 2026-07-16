import { proxyActivities } from "@temporalio/workflow";

import {
  rootRequestSchema,
  type RootRequest,
  type RootResult,
} from "@failure-report/protocol";

import type { FailureReportActivities } from "./activities.js";

const activities = proxyActivities<FailureReportActivities>({
  startToCloseTimeout: "15 minutes",
});

/**
 * Runs one deterministic FailureReport workflow turn.
 *
 * Eve, GitHub, MCP, filesystem, and Codex App-server I/O run inside the
 * `invokeRoot` Activity implementation so Temporal replay never repeats external
 * side effects.
 */
export async function failureReportWorkflow(
  request: RootRequest,
): Promise<RootResult> {
  return activities.invokeRoot(rootRequestSchema.parse(request));
}
