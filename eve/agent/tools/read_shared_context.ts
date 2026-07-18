import { defineTool } from "eve/tools";
import { z } from "zod";

import { getDefaultGithubIssueGateway } from "../lib/integrations/github/gateway-factory.js";
import {
  findExistingWorkpad,
  rehydrateGithubIssueContext,
  type GithubIssueSnapshot,
} from "../lib/integrations/github/issue-workpad.js";

/**
 * Rehydrates the public Root response shape from one read-only Issue snapshot.
 *
 * Keeping this transformation pure makes the no-workpad entry state directly
 * testable and ensures the read tool cannot publish or otherwise mutate GitHub.
 */
export function rehydrateSharedContext(issue: GithubIssueSnapshot) {
  const workpad = findExistingWorkpad(issue);

  return {
    issue,
    shared_context: rehydrateGithubIssueContext(issue, workpad),
    report: workpad?.report ?? null,
    // `null` explicitly means that this existing Issue has not received its
    // first FailureReport workpad yet. The full shared context remains usable
    // for a later Root request without callers fabricating workpad metadata.
    workpad: workpad
      ? { comment_ref: workpad.comment.id, revision: workpad.revision }
      : null,
    // Keep the original scalar read fields for current Root consumers while
    // `shared_context` becomes the canonical follow-up contract.
    workpad_comment_ref: workpad?.comment.id ?? null,
    workpad_revision: workpad?.revision ?? null,
  };
}

/**
 * Read-only Root tool that rehydrates an Issue and its optional structured workpad.
 * A missing workpad is represented as `null`, allowing Root to decide whether to
 * create one rather than treating a new Issue as a transport failure.
 */
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

    return rehydrateSharedContext(issue);
  },
});
