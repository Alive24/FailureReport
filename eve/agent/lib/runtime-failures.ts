/** Redacted host/runtime categories retained in private structured logs. */
export type FailureReportRuntimeFailureCategory =
  | "target_workspace_invalid"
  | "target_workspace_write_denied"
  | "git_fetch_failed"
  | "target_assets_invalid"
  | "handoff_template_invalid"
  | "delivery_policy_invalid"
  | "github_gateway_failed"
  | "tracker_transition_failed"
  | "watcher_exhaustion";

/** Bounded operator guidance suitable for a public `needs_input` result. */
export const runtimeFailureGuidance: Record<
  FailureReportRuntimeFailureCategory,
  string
> = {
  target_workspace_invalid:
    "The process-bound target workspace is invalid or inaccessible. Verify that it is the real canonical Git checkout with a readable origin, then restart FailureReport.",
  target_workspace_write_denied:
    "FailureReport cannot write its missing-only target `.shea` workspace. Repair checkout ownership or permissions outside FailureReport, then restart and retry.",
  git_fetch_failed:
    "FailureReport could not fetch the process-bound target checkout. Verify host Git authentication and repository/network availability, then retry.",
  target_assets_invalid:
    "The target-owned FailureReport `.shea` assets are missing, unreadable, unsafe, or invalid. Repair the target configuration without replacing existing custom files, then retry.",
  handoff_template_invalid:
    "The configured target-owned handoff template is missing, unreadable, empty, or unsafe. Repair the contained regular template file, then retry.",
  delivery_policy_invalid:
    "FAILURE_REPORT_HANDOFF_DELIVERY_POLICY is invalid. Repair the deployment-owned JSON policy and restart FailureReport.",
  github_gateway_failed:
    "FailureReport could not verify the GitHub Issue operation. Repair GitHub credentials, permissions, or availability, then retry the same request.",
  tracker_transition_failed:
    "FailureReport could not verify the configured tracker readback or transition. Repair Project access and configuration, then retry the same request.",
  watcher_exhaustion:
    "The watcher-based development runtime exhausted host file descriptors. Use the supported no-watch start command or repair host watcher capacity outside FailureReport.",
};

/** Internal typed error whose category is safe even when its detail is not. */
export class FailureReportRuntimeError extends Error {
  constructor(
    readonly category: FailureReportRuntimeFailureCategory,
    message = runtimeFailureGuidance[category],
  ) {
    super(message);
    this.name = "FailureReportRuntimeError";
  }
}

export type RuntimeFailureLogger = (entry: string) => void;

/** Returns the typed category or the boundary's safe fallback category. */
export function runtimeFailureCategory(
  error: unknown,
  fallback: FailureReportRuntimeFailureCategory,
): FailureReportRuntimeFailureCategory {
  return error instanceof FailureReportRuntimeError ? error.category : fallback;
}

/** Maps an internal error to bounded public guidance without leaking its detail. */
export function runtimeFailureReason(
  error: unknown,
  fallback: FailureReportRuntimeFailureCategory,
): string {
  return runtimeFailureGuidance[runtimeFailureCategory(error, fallback)];
}

/**
 * Emits only a stable boundary and category. Raw errors may contain checkout
 * paths, remotes, credentials, endpoints, or subprocess output and are never
 * serialized here.
 */
export function logRuntimeFailure(
  boundary: string,
  error: unknown,
  fallback: FailureReportRuntimeFailureCategory,
  logger: RuntimeFailureLogger = console.error,
): void {
  logger(
    JSON.stringify({
      event: "failure-report.runtime-failure",
      boundary,
      category: runtimeFailureCategory(error, fallback),
    }),
  );
}
