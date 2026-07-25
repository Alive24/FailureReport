import { defineTool } from "eve/tools";
import { z } from "zod";

import { createDiagnosticHandoffRenderer } from "../lib/diagnostics/handoff-renderer.js";

const renderHandoff = createDiagnosticHandoffRenderer();

/**
 * Root's read-only, revision-bound boundary for implementation handoffs and
 * precise human-input requests. The caller supplies identities, never content
 * to render; the renderer rehydrates the complete latest managed workpad.
 */
export default defineTool({
  description:
    "Render a deterministic implementation handoff or human-input request from the latest provenance-verified managed workpad without publishing or mutating lifecycle state.",
  inputSchema: z
    .object({
      report_id: z.string().min(1),
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      issue_number: z.number().int().positive(),
      expected_workpad_revision: z.number().int().nonnegative(),
      expected_workpad_logical_session_id: z.string().min(1),
      expected_workpad_entry_id: z.string().min(1),
      expected_target_revision: z
        .string()
        .regex(
          /^[0-9a-f]{40,64}$/i,
          "revision must be a full immutable Git SHA",
        ),
    })
    .strict(),
  async execute(input) {
    return renderHandoff(input);
  },
  toModelOutput(output) {
    return {
      type: "json",
      value: output,
    };
  },
});
