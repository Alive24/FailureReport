import { defineTool } from "eve/tools";
import { z } from "zod";

import { failureReportSchema } from "@failure-report/protocol";

import { prepareIssueWorkpadMutation } from "../../integrations/github/issue-workpad.js";

/**
 * Snapshot shape accepted by the side-effect-free workpad preparation tool.
 * It mirrors the gateway's read model rather than accepting arbitrary Issue JSON.
 */
const issueSnapshotSchema = z
  .object({
    repository: z.string().min(1),
    issue_number: z.number().int().positive(),
    issue_url: z.string().min(1),
    body: z.string(),
    updated_at: z.string().min(1),
    comments: z.array(
      z
        .object({
          id: z.string().min(1),
          body: z.string(),
          updated_at: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Prepares an optimistic-concurrency-checked Issue workpad mutation without I/O.
 * Root can inspect the resulting revision/body before calling the approval-gated
 * publishing tool.
 */
export default defineTool({
  description:
    "Prepare a revision-checked GitHub Issue workpad update without publishing it.",
  inputSchema: z
    .object({
      issue: issueSnapshotSchema,
      report: failureReportSchema,
      synced_at: z.string().min(1),
    })
    .strict(),
  async execute(input) {
    return prepareIssueWorkpadMutation(
      input.issue,
      input.report,
      input.synced_at,
    );
  },
});
