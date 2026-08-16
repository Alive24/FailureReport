import { preflightHostRuntime } from "./host-runtime-readiness.js";
import { logRuntimeFailure, runtimeFailureReason } from "./runtime-failures.js";

try {
  const result = await preflightHostRuntime();
  console.error(
    JSON.stringify({
      event: "failure-report.host-runtime-readiness",
      status: result.status,
      delivery_policy: result.delivery_policy,
    }),
  );
} catch (error) {
  logRuntimeFailure("host-runtime-startup", error, "target_workspace_invalid");
  console.error(
    "FailureReport startup preflight failed: " +
      runtimeFailureReason(error, "target_workspace_invalid"),
  );
  process.exitCode = 1;
}
