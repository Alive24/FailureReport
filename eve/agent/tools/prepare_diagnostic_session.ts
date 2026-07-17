import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import backendJson from "../../config/workers/codex-app-server.json" with { type: "json" };

import { parseCodexAppServerBackendConfig } from "../lib/backends/codex-app-server-config.js";
import { createDiagnosticSessionPreparer } from "../lib/diagnostics/session-preparer.js";

const backend = parseCodexAppServerBackendConfig(backendJson);
const prepareDiagnosticSession = createDiagnosticSessionPreparer({
  backend_id: backend.kind,
  worktree_root: backend.worktree_root,
});

/**
 * Root's only mutable diagnostic-session preparation boundary.
 *
 * Input deliberately contains report/Issue identity, domain, and a bounded
 * request only. Root resolves all checkout, branch, backend, and native-skill
 * policy from its fixed host configuration and domain-profile registry.
 */
export default defineTool({
  description:
    "Prepare or resume an approval-gated Root-owned diagnostic worktree and return the only valid Codex diagnostic delegation message.",
  inputSchema: z
    .object({
      report_id: z.string().min(1),
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      issue_number: z.number().int().positive(),
      domain_id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
      request: z.string().min(1),
    })
    .strict(),
  // Allocation/restoration creates or validates a Git worktree and publishes its
  // durable session state, so every invocation requires Root approval.
  approval: always(),
  async execute(input) {
    return prepareDiagnosticSession(input);
  },
  toModelOutput(output) {
    return {
      type: "json",
      value: output,
    };
  },
});
