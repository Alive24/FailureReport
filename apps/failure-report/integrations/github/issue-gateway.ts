import type { FailureReport } from "@failure-report/protocol";

import {
  type GithubIssueSnapshot,
  type IssueWorkpadMutation,
  findExistingWorkpad,
  prepareIssueWorkpadMutation,
  upsertIssueNarrative,
} from "./issue-workpad.js";

export type PublishedSharedContext = {
  issue: GithubIssueSnapshot;
  report: FailureReport;
  workpad_comment_ref: string;
  workpad_revision: number;
};

/**
 * Root's internal GitHub Issue port. It intentionally exposes only the
 * read/publish operations needed for the Issue narrative and workpad.
 */
export interface GithubIssueGateway {
  readIssue(
    repository: string,
    issueNumber: number,
  ): Promise<GithubIssueSnapshot>;
  publishSharedContext(
    repository: string,
    issueNumber: number,
    report: FailureReport,
    syncedAt: string,
  ): Promise<PublishedSharedContext>;
}

/**
 * Keeps FailureReport's application-owned concurrency checks independent from
 * the transport used to call GitHub. GitHub does not provide a compare-and-swap
 * operation for Issue comments, so every implementation must re-read before
 * creating or updating the marked workpad comment.
 */
export abstract class IssueWorkpadGateway implements GithubIssueGateway {
  abstract readIssue(
    repository: string,
    issueNumber: number,
  ): Promise<GithubIssueSnapshot>;

  async publishSharedContext(
    repository: string,
    issueNumber: number,
    report: FailureReport,
    syncedAt: string,
  ): Promise<PublishedSharedContext> {
    let issue = await this.readIssue(repository, issueNumber);
    // Reject a stale report before it can modify either the Issue narrative or workpad.
    let mutation = prepareIssueWorkpadMutation(issue, report, syncedAt);
    const nextBody = upsertIssueNarrative(issue.body, mutation.report);
    if (nextBody !== issue.body) {
      await this.updateIssueBody(repository, issueNumber, nextBody);
      issue = await this.readIssue(repository, issueNumber);
      mutation = prepareIssueWorkpadMutation(issue, report, syncedAt);
    }

    const latest = await this.readIssue(repository, issueNumber);
    assertFreshWorkpadMutation(latest, mutation);
    const commentRef = await this.writeWorkpad(
      repository,
      issueNumber,
      mutation,
    );

    return {
      issue,
      report: mutation.report,
      workpad_comment_ref: commentRef,
      workpad_revision: mutation.report.shared_context?.workpad_revision ?? 0,
    };
  }

  protected abstract updateIssueBody(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<void>;

  protected abstract createWorkpadComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<string>;

  protected abstract updateWorkpadComment(
    repository: string,
    commentRef: string,
    body: string,
  ): Promise<string>;

  private async writeWorkpad(
    repository: string,
    issueNumber: number,
    mutation: IssueWorkpadMutation,
  ): Promise<string> {
    if (mutation.mode === "create") {
      return this.createWorkpadComment(
        repository,
        issueNumber,
        mutation.workpad_comment_body,
      );
    }

    const commentRef = mutation.workpad_comment_ref;
    if (!commentRef) {
      throw new Error("Missing workpad comment reference for an update.");
    }
    return this.updateWorkpadComment(
      repository,
      commentRef,
      mutation.workpad_comment_body,
    );
  }
}

export function assertFreshWorkpadMutation(
  issue: GithubIssueSnapshot,
  mutation: IssueWorkpadMutation,
): void {
  if (issue.updated_at !== mutation.expected_issue_updated_at) {
    throw new Error(
      "GitHub Issue changed while preparing the FailureReport workpad.",
    );
  }
  const current = findExistingWorkpad(issue);
  const revision = current?.revision ?? null;
  if (revision !== mutation.expected_workpad_revision) {
    throw new Error(
      "FailureReport workpad changed while preparing the update.",
    );
  }
}
