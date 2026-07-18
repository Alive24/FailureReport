import { defineTool } from "eve/tools";
import { z } from "zod";

import backendJson from "../../config/workers/codex-app-server.json" with { type: "json" };

import { parseCodexAppServerBackendConfig } from "../lib/backends/codex-app-server-config.js";
import { createDiagnosticSessionFinalizer } from "../lib/diagnostics/session-finalizer.js";

const backend = parseCodexAppServerBackendConfig(backendJson);
const finalizeDiagnosticSession = createDiagnosticSessionFinalizer({
  backend_id: backend.kind,
});

/**
 * Root's explicit boundary for creating and publishing a diagnostic snapshot.
 *
 * No caller can supply a checkout, ref, branch, extension, or skill source. Root
 * rehydrates that state from the durable workpad and only finalizes a clean active
 * diagnostic worktree.
 */
export default defineTool({
  description:
    "Finalize a clean Root-owned diagnostic session into a diagnostic-only snapshot branch without checking it out.",
  inputSchema: z
    .object({
      report_id: z.string().min(1),
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      issue_number: z.number().int().positive(),
    })
    .strict(),
  async execute(input) {
    return finalizeDiagnosticSession(input);
  },
  toModelOutput(output) {
    return {
      type: "json",
      value: output,
    };
  },
});
