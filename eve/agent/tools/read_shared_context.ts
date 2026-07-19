import { defineTool } from "eve/tools";
import { z } from "zod";

import { workpadMarker } from "@failure-report/protocol";

import { getDefaultGithubIssueGateway } from "../lib/integrations/github/gateway-factory.js";
import {
  type ExistingWorkpad,
  type GithubIssueSnapshot,
  type WorkpadProducerConfiguration,
  WorkpadNeedsInputError,
  findExistingWorkpad,
  rehydrateGithubIssueContext,
} from "../lib/integrations/github/issue-workpad.js";

/**
 * Finds a verified workpad only when the Issue contains a managed marker.
 *
 * A no-workpad Issue has no managed state to authenticate, so a read-only
 * initial selector remains usable without publisher configuration. Once a
 * marker exists, producer configuration is mandatory and malformed or
 * untrusted history still fails closed through `findExistingWorkpad`.
 */
export function findVerifiedWorkpadForRead(
  issue: GithubIssueSnapshot,
  getProducerConfiguration: () => WorkpadProducerConfiguration,
): ExistingWorkpad | undefined {
  if (!issue.comments.some((comment) => comment.body.includes(workpadMarker))) {
    return undefined;
  }
  return findExistingWorkpad(issue, getProducerConfiguration());
}

/**
 * Rehydrates the public Root response shape from one read-only Issue snapshot.
 *
 * Keeping this transformation pure makes the no-workpad entry state directly
 * testable and ensures the read tool cannot publish or otherwise mutate GitHub.
 */
export function rehydrateSharedContext(
  issue: GithubIssueSnapshot,
  workpad: ExistingWorkpad | undefined,
) {
  return {
    status: "ok" as const,
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
      const workpad = findVerifiedWorkpadForRead(issue, () =>
        gateway.getWorkpadProducerConfiguration(),
      );

      return rehydrateSharedContext(issue, workpad);
    } catch (error) {
      if (error instanceof WorkpadNeedsInputError) {
        return {
          status: "needs_input" as const,
          issue: null,
          shared_context: null,
          report: null,
          workpad: null,
          workpad_comment_ref: null,
          workpad_revision: null,
          reason: error.message,
        };
      }
      throw error;
    }
  },
});
