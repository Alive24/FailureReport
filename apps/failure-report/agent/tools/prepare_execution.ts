import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  prepareDomainExecution,
  UnknownDomainExecutionError,
} from "../../src/domain-packs/registry.js";
import { ExecutionSafetyError } from "../../src/execution/worktree.js";

/**
 * Root-only approval gate for internal domain execution preparation.
 *
 * The tool returns a delegation message rather than a filesystem path so a model
 * cannot invent or redirect an isolated worktree before the domain backend checks
 * the durable workpad again.
 */
export default defineTool({
  description:
    "Approval-gated Root preparation for a private domain execution: select a configured domain pack, allocate or validate an isolated worktree, persist execution state, and return the only valid delegation message.",
  inputSchema: z
    .object({
      domain_id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
      report_id: z.string().min(1),
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      issue_number: z.number().int().positive(),
      request: z.string().min(1),
    })
    .strict(),
  // Allocation/restore changes durable state and may create a writable worktree.
  approval: always(),
  async execute(input) {
    try {
      const prepared = await prepareDomainExecution(input);
      return { status: "prepared" as const, prepared };
    } catch (error) {
      if (error instanceof ExecutionSafetyError) {
        return {
          status: "needs_input" as const,
          report_id: input.report_id,
          reason: error.message,
        };
      }
      if (error instanceof UnknownDomainExecutionError) {
        return {
          status: "unsupported_domain" as const,
          report_id: input.report_id,
          domain_id: input.domain_id,
          reason: error.message,
        };
      }
      throw error;
    }
  },
  toModelOutput(output) {
    if (output.status !== "prepared") {
      // Safety and registry rejections remain structured model output so Root can
      // request explicit operator input instead of silently trying another path.
      return {
        type: "json",
        value: output,
      };
    }
    const prepared = output.prepared;
    return {
      type: "json",
      value: {
        status: output.status,
        domain_id: prepared.execution.state.domain_id,
        report_id: prepared.report.id,
        workpad_revision: prepared.workpad_revision,
        delegation_message: prepared.delegation_message,
      },
    };
  },
});
