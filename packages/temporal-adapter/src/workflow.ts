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
 * Deterministic orchestration only. Eve, GitHub, MCP, filesystem, and Codex
 * App-server I/O run inside invokeRoot Activity implementations.
 */
export async function failureReportWorkflow(
  request: RootRequest,
): Promise<RootResult> {
  return activities.invokeRoot(rootRequestSchema.parse(request));
}
