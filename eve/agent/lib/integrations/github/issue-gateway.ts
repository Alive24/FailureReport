import type { FailureReport } from "@failure-report/protocol";

import {
  type GithubActorIdentity,
  type GithubIssueSnapshot,
  type IssueWorkpadMutation,
  type WorkpadProducerConfiguration,
  WorkpadNeedsInputError,
  findExistingWorkpad,
  prepareIssueWorkpadMutation,
  validateProducerConfiguration,
} from "./issue-workpad.js";

/**
 * Transport-neutral GitHub Issue workpad port and owner-scoped publication flow.
 *
 * Root is still the only publisher. The gateway never updates Issue bodies and
 * only updates an existing comment after provenance proves the same immutable
 * GitHub actor owns it.
 */

/** Result of a successful managed-comment publication. */
export type PublishedSharedContext = {
  issue: GithubIssueSnapshot;
  report: FailureReport;
  workpad_comment_ref: string;
  workpad_revision: number;
};

/**
 * A verified optimistic-concurrency race. Root may reload logical state and
 * make one bounded retry; callers must never treat it as permission to replay a
 * stale report snapshot.
 */
export class WorkpadPublicationRaceError extends WorkpadNeedsInputError {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "WorkpadPublicationRaceError";
  }
}

/** A failed post-write readback whose durable outcome could not be verified. */
export class WorkpadPostWriteReadbackError extends WorkpadNeedsInputError {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "WorkpadPostWriteReadbackError";
    this.retryable = retryable;
  }
}

/** Narrows the only publication errors a reconciliation transaction may retry. */
export function isRetryableWorkpadPublicationError(
  error: unknown,
): error is WorkpadPublicationRaceError | WorkpadPostWriteReadbackError {
  return (
    error instanceof WorkpadPublicationRaceError ||
    (error instanceof WorkpadPostWriteReadbackError && error.retryable)
  );
}

/** Root's internal GitHub Issue port. */
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
  getWorkpadProducerConfiguration(): WorkpadProducerConfiguration;
}

/** Shared implementation for Octokit and the explicit gh fallback. */
export abstract class IssueWorkpadGateway implements GithubIssueGateway {
  private readonly producers?: WorkpadProducerConfiguration;

  protected constructor(producers?: WorkpadProducerConfiguration) {
    this.producers = producers && validateProducerConfiguration(producers);
  }

  getWorkpadProducerConfiguration(): WorkpadProducerConfiguration {
    if (!this.producers) {
      throw new WorkpadNeedsInputError(
        "FailureReport workpad producer configuration is required before reentry or publication.",
      );
    }
    return this.producers;
  }

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
    const producers = this.getWorkpadProducerConfiguration();
    const authenticatedActor = await this.readAuthenticatedActor();
    if (authenticatedActor.id !== producers.current.github_actor_id) {
      throw new WorkpadNeedsInputError(
        "Configured FailureReport producer does not match the authenticated GitHub actor.",
      );
    }

    const issue = await this.readIssue(repository, issueNumber);
    const mutation = prepareIssueWorkpadMutation(
      issue,
      report,
      syncedAt,
      producers,
    );

    const latest = await this.readIssue(repository, issueNumber);
    assertFreshWorkpadMutation(latest, mutation, producers);
    const commentRef = await this.writeWorkpad(
      repository,
      issueNumber,
      mutation,
    );

    // A post-write read validates the actual GitHub author before returning the
    // report as durable state. A credential mismatch can never become trusted.
    let persistedIssue: GithubIssueSnapshot;
    let persisted: ReturnType<typeof findExistingWorkpad>;
    try {
      persistedIssue = await this.readIssue(repository, issueNumber);
      persisted = findExistingWorkpad(persistedIssue, producers);
    } catch (error) {
      if (error instanceof WorkpadNeedsInputError) {
        throw error;
      }
      throw new WorkpadPostWriteReadbackError(
        "FailureReport publication could not verify its post-write logical-state readback.",
        isTransientPublicationFailure(error),
      );
    }
    if (!persisted || persisted.comment.id !== commentRef) {
      throw new WorkpadPublicationRaceError(
        "FailureReport publication did not produce the expected verified lineage head.",
      );
    }
    if (
      persisted.entry.entry_id !== mutation.entry.entry_id ||
      persisted.revision !== mutation.entry.revision
    ) {
      throw new WorkpadPublicationRaceError(
        "FailureReport publication readback does not match the prepared entry.",
      );
    }

    return {
      issue: persistedIssue,
      report: persisted.report,
      workpad_comment_ref: persisted.comment.id,
      workpad_revision: persisted.revision,
    };
  }

  /** Reads the immutable GitHub identity used by the active transport credentials. */
  protected abstract readAuthenticatedActor(): Promise<GithubActorIdentity>;

  protected abstract createWorkpadComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<string>;

  /** Only used for a same-actor append after provenance validation. */
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
    if (mutation.mode === "create" || mutation.mode === "continue") {
      return this.createWorkpadComment(
        repository,
        issueNumber,
        mutation.workpad_comment_body,
      );
    }

    const commentRef = mutation.target_comment_ref;
    if (!commentRef) {
      throw new WorkpadNeedsInputError(
        "Same-producer append is missing its verified target comment reference.",
      );
    }
    return this.updateWorkpadComment(
      repository,
      commentRef,
      mutation.workpad_comment_body,
    );
  }
}

/** Rechecks all optimistic-concurrency and lineage preconditions immediately before write. */
export function assertFreshWorkpadMutation(
  issue: GithubIssueSnapshot,
  mutation: IssueWorkpadMutation,
  producers: WorkpadProducerConfiguration,
): void {
  if (issue.updated_at !== mutation.expected_issue_updated_at) {
    throw new WorkpadPublicationRaceError(
      "GitHub Issue changed while preparing the FailureReport workpad.",
    );
  }
  const current = findExistingWorkpad(issue, producers);
  const revision = current?.revision ?? null;
  if (revision !== mutation.expected_workpad_revision) {
    throw new WorkpadPublicationRaceError(
      "FailureReport workpad changed while preparing the update.",
    );
  }
  if (
    current?.comment.id !== mutation.expected_workpad_comment_ref &&
    mutation.expected_workpad_comment_ref !== undefined
  ) {
    throw new WorkpadPublicationRaceError(
      "FailureReport workpad head changed while preparing the update.",
    );
  }
  if (mutation.mode === "create" && current) {
    throw new WorkpadPublicationRaceError(
      "A FailureReport workpad appeared before first publication.",
    );
  }
  if (
    mutation.mode === "append" &&
    (!current ||
      current.producer.github_actor_id !== producers.current.github_actor_id)
  ) {
    throw new WorkpadPublicationRaceError(
      "Same-producer append no longer has a verified owned lineage head.",
    );
  }
  if (
    mutation.mode === "continue" &&
    (!current || current.comment.id !== mutation.predecessor_comment_ref)
  ) {
    throw new WorkpadPublicationRaceError(
      "Producer continuation no longer has the verified predecessor comment.",
    );
  }
}

/** Only transport failures known to be transient may enter a bounded retry. */
function isTransientPublicationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") {
    return (
      candidate.status === 408 ||
      candidate.status === 409 ||
      candidate.status === 429 ||
      candidate.status >= 500
    );
  }
  return (
    candidate.code === "ECONNRESET" ||
    candidate.code === "ETIMEDOUT" ||
    candidate.code === "EAI_AGAIN"
  );
}
