import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import extension, { ckbDomainId } from "../extension";
import { withCkbDelegationGuidance } from "../lib/delegation";

/**
 * Approval-gated CKB execution preparation.
 * The consumer performs the worktree/workpad mutation through injected policy;
 * this extension owns the CKB request shape and delegation guidance.
 */
export default defineTool({
  description:
    "Prepare an approval-gated CKB coding investigation in a verified isolated worktree and return the only valid Codex delegation message.",
  inputSchema: z
    .object({
      report_id: z.string().min(1),
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      issue_number: z.number().int().positive(),
      request: z.string().min(1),
    })
    .strict(),
  approval: always(),
  async execute(input) {
    const prepared = await extension.config.prepareExecution({
      domain_id: ckbDomainId,
      ...input,
    });
    if (prepared.status !== "prepared") {
      return prepared;
    }
    return {
      ...prepared,
      delegation_message: withCkbDelegationGuidance(
        prepared.delegation_message,
      ),
    };
  },
  toModelOutput(output) {
    return {
      type: "json",
      value: output,
    };
  },
});
