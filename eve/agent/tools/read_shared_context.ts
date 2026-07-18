import { defineTool } from "eve/tools";
import { z } from "zod";

import { getDefaultGithubIssueGateway } from "../lib/integrations/github/gateway-factory.js";
import {
  type GithubIssueSnapshot,
  WorkpadNeedsInputError,
  findExistingWorkpad,
} from "../lib/integrations/github/issue-workpad.js";

/**
 * Read-only Root tool that rehydrates an Issue and its optional verified workpad
 * lineage. A missing workpad is represented as `null`; any marked but untrusted
 * history fails closed instead of being silently selected.
 */
export default defineTool({
  description:
    "Rehydrate public FailureReport shared context from a provenance-verified GitHub Issue workpad lineage.",
  inputSchema: z
    .object({
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      issue_number: z.number().int().positive(),
    })
    .strict(),
  async execute(input) {
    let issue: GithubIssueSnapshot | null = null;
    try {
      const gateway = await getDefaultGithubIssueGateway();
      issue = await gateway.readIssue(input.repository, input.issue_number);
      const workpad = findExistingWorkpad(
        issue,
        gateway.getWorkpadProducerConfiguration(),
      );

      return {
        status: "ok" as const,
        issue,
        ...(workpad
          ? {
              report: workpad.report,
              workpad_comment_ref: workpad.comment.id,
              workpad_revision: workpad.revision,
            }
          : {
              report: null,
              workpad_comment_ref: null,
              workpad_revision: null,
            }),
      };
    } catch (error) {
      if (error instanceof WorkpadNeedsInputError) {
        return {
          status: "needs_input" as const,
          issue: null,
          report: null,
          workpad_comment_ref: null,
          workpad_revision: null,
          reason: error.message,
        };
      }
      throw error;
    }
  },
});
