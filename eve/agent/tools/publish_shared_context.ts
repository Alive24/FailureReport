import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { failureReportSchema } from "@failure-report/protocol";

import { getDefaultGithubIssueGateway } from "../lib/integrations/github/gateway-factory.js";
import { WorkpadNeedsInputError } from "../lib/integrations/github/issue-workpad.js";

/**
 * Root-only GitHub publication tool for the managed-comment workpad lineage.
 * It is always approval-gated because it performs an external mutable action.
 */
export default defineTool({
  description:
    "Publish a Root-owned, provenance-verified FailureReport workpad entry through the configured GitHub SDK gateway.",
  inputSchema: z
    .object({
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      issue_number: z.number().int().positive(),
      report: failureReportSchema,
    })
    .strict(),
  // Publishing changes a user-owned GitHub Issue and therefore always requires consent.
  approval: always(),
  async execute(input) {
    try {
      const gateway = await getDefaultGithubIssueGateway();
      const published = await gateway.publishSharedContext(
        input.repository,
        input.issue_number,
        input.report,
        new Date().toISOString(),
      );

      return {
        status: "ok" as const,
        report: published.report,
        issue_url: published.issue.issue_url,
        workpad_comment_ref: published.workpad_comment_ref,
        workpad_revision: published.workpad_revision,
      };
    } catch (error) {
      if (error instanceof WorkpadNeedsInputError) {
        return { status: "needs_input" as const, reason: error.message };
      }
      throw error;
    }
  },
});
