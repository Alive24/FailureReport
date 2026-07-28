import { defineCatalystEveInstrumentation } from "@inference/tracing/eve";

const captureEnabled = process.env.FAILURE_REPORT_REAL_TRACE_CAPTURE === "1";

/**
 * Framework-native Eve tracing is intentionally dormant during ordinary
 * FailureReport operation. The explicit real-capture harness supplies the
 * enablement flag, loopback endpoint, and immutable service version.
 */
export default captureEnabled
  ? defineCatalystEveInstrumentation({
      functionId: "failure-report-root",
      serviceName: "failure-report-eve-root",
      serviceVersion: process.env.CATALYST_SERVICE_VERSION,
      recordInputs: false,
      recordOutputs: false,
      batching: "simple",
      metadata: {
        "failure_report.component": "eve-root",
        "failure_report.capture.mode": "real-root-to-codex",
      },
    })
  : undefined;
