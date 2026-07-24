import { defineCatalystEveInstrumentation } from "@inference/tracing/eve";

/**
 * Framework-native tracing for FailureReport's Eve Root.
 *
 * Eve 0.24 loads this file as its telemetry enablement signal. The matching
 * official Inference guide says to install Catalyst through this hook instead
 * of calling tracing setup from agent code. Native Eve instrumentation covers
 * Root turns, model calls, sub-agent invocations, and tool execution without
 * adding duplicate application spans around Eve tools.
 */
export default defineCatalystEveInstrumentation({
  functionId: "failure-report-root",
  serviceName: "failure-report-eve-root",
  metadata: {
    "deployment.environment": process.env.NODE_ENV ?? "development",
    "failure_report.component": "eve-root",
    "failure_report.trace_guide.url":
      "https://docs.inference.net/integrations/traces/eve.md",
    "failure_report.trace_guide.retrieved_at":
      "2026-07-24T18:21:08.942664+00:00",
    "failure_report.trace_guide.sha256":
      "4cb9dcf2e3537f4f1cb7be1644bfb13d07e25754baf8c25cad335cdfd10a5c2e",
    "failure_report.trace_guide.selection":
      "Current official catalog ranks Vercel Eve Traces for @inference/tracing and Eve 0.24.4.",
  },
  batching: "simple",
});
