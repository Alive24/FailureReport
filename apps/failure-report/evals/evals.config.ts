import { defineEvalConfig } from "eve/evals";

/**
 * Conservative evaluation defaults for local-first agent runs.
 * Sequential execution avoids overlapping local Codex/Eve sessions while fixture
 * cases are still small enough to complete within the configured two-minute cap.
 */
export default defineEvalConfig({
  maxConcurrency: 1,
  timeoutMs: 120000,
});
