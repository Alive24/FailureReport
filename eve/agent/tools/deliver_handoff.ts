import { defineTool } from "eve/tools";
import { z } from "zod";

import { createDiagnosticHandoffDelivery } from "../lib/delivery/handoff-delivery.js";

const deliverHandoff = createDiagnosticHandoffDelivery();

/**
 * Root-only configured delivery boundary. The caller binds the durable report
 * revision but cannot select a target template, Project, field, or destination.
 */
export default defineTool({
  description:
    "Publish a target-owned human-readable implementation handoff and, only when the target repository configures its own Project, move that item to Backlog or Todo after readback.",
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
    return deliverHandoff(input);
  },
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});
