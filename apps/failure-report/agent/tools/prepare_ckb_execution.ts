import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import backendJson from "../subagents/ckb/config/backend/codex-app-server.json" with { type: "json" };

import { parseCkbBackendConfig } from "../../src/backend-config.js";
import { createCkbExecutionWorkpad } from "../../src/backends/ckb-codex-model.js";
import { WorktreeSafetyError } from "../../src/execution/ckb-worktree.js";

const backend = parseCkbBackendConfig(backendJson);

export default defineTool({
  description:
    "Approval-gated Root preparation for a private CKB Codex execution: allocate or validate its isolated worktree, persist execution state, and return the only valid CKB delegation message.",
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
    try {
      const prepared = await createCkbExecutionWorkpad(backend).prepare({
        schema_version: "failure-report/ckb-execution/v1",
        ...input,
      });
      return { status: "prepared" as const, prepared };
    } catch (error) {
      if (error instanceof WorktreeSafetyError) {
        return {
          status: "needs_input" as const,
          report_id: input.report_id,
          reason: error.message,
        };
      }
      throw error;
    }
  },
  toModelOutput(output) {
    if (output.status === "needs_input") {
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
        report_id: prepared.report.id,
        workpad_revision: prepared.workpad_revision,
        delegation_message: prepared.delegation_message,
      },
    };
  },
});
