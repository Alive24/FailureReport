#!/usr/bin/env node

import {
  CaptureError,
  loadCaptureConfiguration,
  runRealRootCodexTraceCapture,
} from "./root-codex-trace-capture.mjs";

try {
  const configuration = await loadCaptureConfiguration();
  const receipt = await runRealRootCodexTraceCapture(configuration);
  process.stdout.write(JSON.stringify(receipt) + "\n");
} catch (error) {
  const failureCode =
    error instanceof CaptureError ? error.code : "internal_error";
  process.stderr.write(
    JSON.stringify({
      status_classification: "failed",
      failure_code: failureCode,
    }) + "\n",
  );
  process.exitCode = 1;
}
