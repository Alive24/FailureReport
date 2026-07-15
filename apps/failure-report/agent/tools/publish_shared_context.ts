import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { failureReportSchema } from "@failure-report/protocol";

import { GithubCliIssueGateway } from "../../integrations/github/github-cli.js";

export default defineTool({
  description:
    "Publish the Root-owned Issue narrative and single structured workpad comment through gh api.",
  inputSchema: z
    .object({
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      issue_number: z.number().int().positive(),
      report: failureReportSchema,
    })
    .strict(),
  approval: always(),
  async execute(input) {
    const gateway = new GithubCliIssueGateway();
    const published = await gateway.publishSharedContext(
      input.repository,
      input.issue_number,
      input.report,
      new Date().toISOString(),
    );

    return {
      report: published.report,
      issue_url: published.issue.issue_url,
      workpad_comment_ref: published.workpad_comment_ref,
      workpad_revision: published.workpad_revision,
    };
  },
});
