import { defineTool } from "eve/tools";
import { z } from "zod";

import { getDefaultGithubIssueGateway } from "../../integrations/github/gateway-factory.js";
import { findExistingWorkpad } from "../../integrations/github/issue-workpad.js";

export default defineTool({
  description:
    "Rehydrate the public FailureReport shared context from its target GitHub Issue and unique workpad comment.",
  inputSchema: z
    .object({
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      issue_number: z.number().int().positive(),
    })
    .strict(),
  async execute(input) {
    const gateway = await getDefaultGithubIssueGateway();
    const issue = await gateway.readIssue(input.repository, input.issue_number);
    const workpad = findExistingWorkpad(issue);

    return {
      issue,
      ...(workpad
        ? {
            report: workpad.report,
            workpad_comment_ref: workpad.comment.id,
            workpad_revision: workpad.revision,
          }
        : { report: null, workpad_comment_ref: null, workpad_revision: null }),
    };
  },
});
