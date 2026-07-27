import type { FailureReport } from "@failure-report/protocol";

import {
  type GithubActorIdentity,
  type GithubIssueSnapshot,
  type IssueWorkpadMutation,
  type WorkpadProducerConfiguration,
  WorkpadNeedsInputError,
  defaultGithubWorkpadEncodedByteBudget,
  findExistingWorkpad,
  prepareVerifiedWorkpadManifest,
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

/** Provider readback for one idempotently published handoff comment. */
export type PublishedHandoffComment = {
  issue: GithubIssueSnapshot;
  comment_ref: string;
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
  publishHandoffComment(
    repository: string,
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<PublishedHandoffComment>;
  getWorkpadProducerConfiguration(): WorkpadProducerConfiguration;
}

/** Shared implementation for Octokit and the explicit gh fallback. */
export abstract class IssueWorkpadGateway implements GithubIssueGateway {
  private readonly producers?: WorkpadProducerConfiguration;
  private readonly encodedByteBudget: number;

  protected constructor(
    producers?: WorkpadProducerConfiguration,
    encodedByteBudget = defaultGithubWorkpadEncodedByteBudget,
  ) {
    this.producers = producers && validateProducerConfiguration(producers);
    this.encodedByteBudget = encodedByteBudget;
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

  /**
   * Creates a new human-readable handoff comment without modifying an existing
   * comment. A stable marker makes process-loss retry idempotent; conflicting
   * or duplicated markers fail closed instead of guessing which delivery won.
   */
  async publishHandoffComment(
    repository: string,
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<PublishedHandoffComment> {
    if (
      !marker.startsWith("<!-- failure-report-handoff-delivery/v1 ") ||
      !marker.endsWith(" -->") ||
      !body.startsWith(marker + "\n")
    ) {
      throw new WorkpadNeedsInputError(
        "FailureReport handoff delivery requires its exact versioned marker at the start of the comment.",
      );
    }
    const producers = this.getWorkpadProducerConfiguration();
    const actor = await this.readAuthenticatedActor();
    if (actor.id !== producers.current.github_actor_id) {
      throw new WorkpadNeedsInputError(
        "Configured FailureReport producer does not match the authenticated GitHub actor.",
      );
    }

    const existing = await this.readIssue(repository, issueNumber);
    const reusable = findHandoffComments(existing, marker);
    if (reusable.length > 1) {
      throw new WorkpadNeedsInputError(
        "FailureReport handoff delivery found duplicate provider markers and requires operator resolution.",
      );
    }
    const prior = reusable[0];
    if (prior) {
      assertReusableHandoffComment(prior, body, actor.id);
      return { issue: existing, comment_ref: prior.id };
    }

    const latest = await this.readIssue(repository, issueNumber);
    const raced = findHandoffComments(latest, marker);
    if (raced.length > 1) {
      throw new WorkpadNeedsInputError(
        "FailureReport handoff delivery found duplicate provider markers and requires operator resolution.",
      );
    }
    if (raced[0]) {
      assertReusableHandoffComment(raced[0], body, actor.id);
      return { issue: latest, comment_ref: raced[0].id };
    }

    const commentRef = await this.createIssueComment(
      repository,
      issueNumber,
      body,
    );
    const readback = await this.readIssue(repository, issueNumber);
    const persisted = findHandoffComments(readback, marker);
    if (persisted.length !== 1 || persisted[0]?.id !== commentRef) {
      throw new WorkpadPostWriteReadbackError(
        "FailureReport could not verify one unique handoff comment after publication.",
      );
    }
    assertReusableHandoffComment(persisted[0], body, actor.id);
    return { issue: readback, comment_ref: commentRef };
  }

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
      this.encodedByteBudget,
    );

    const latest = await this.readIssue(repository, issueNumber);
    assertFreshWorkpadMutation(latest, mutation, producers);
    const commentRef = await this.writeWorkpad(
      repository,
      issueNumber,
      mutation,
      producers,
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

  protected abstract createIssueComment(
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
    producers: WorkpadProducerConfiguration,
  ): Promise<string> {
    if (mutation.mode === "chunk") {
      const commentRefs: string[] = [];
      for (const planned of mutation.chunks) {
        const latest = await this.readIssue(repository, issueNumber);
        assertFreshWorkpadMutation(latest, mutation, producers, true);
        if (planned.existing_comment_ref) {
          const reusable = latest.comments.filter(
            (comment) => comment.id === planned.existing_comment_ref,
          );
          if (
            reusable.length !== 1 ||
            reusable[0]?.body !== planned.workpad_comment_body ||
            reusable[0]?.author?.id !== producers.current.github_actor_id
          ) {
            throw new WorkpadPublicationRaceError(
              "FailureReport provisional chunk changed before safe retry reuse.",
            );
          }
          commentRefs.push(planned.existing_comment_ref);
          continue;
        }

        const created = await this.createIssueComment(
          repository,
          issueNumber,
          planned.workpad_comment_body,
        );
        let readback: GithubIssueSnapshot;
        try {
          readback = await this.readIssue(repository, issueNumber);
        } catch (error) {
          throw new WorkpadPostWriteReadbackError(
            "FailureReport could not read back a provisional chunk after publication.",
            isTransientPublicationFailure(error),
          );
        }
        assertFreshWorkpadMutation(readback, mutation, producers, true);
        const persisted = readback.comments.filter(
          (comment) => comment.id === created,
        );
        if (
          persisted.length !== 1 ||
          persisted[0]?.body !== planned.workpad_comment_body ||
          persisted[0]?.author?.id !== producers.current.github_actor_id
        ) {
          throw new WorkpadPostWriteReadbackError(
            "FailureReport could not verify a provisional chunk after publication.",
          );
        }
        commentRefs.push(created);
      }

      const latest = await this.readIssue(repository, issueNumber);
      assertFreshWorkpadMutation(latest, mutation, producers, true);
      const manifestBody = prepareVerifiedWorkpadManifest(
        latest,
        mutation,
        commentRefs,
        producers,
      );
      // This create is the sole visibility boundary for the logical revision.
      return this.createIssueComment(repository, issueNumber, manifestBody);
    }

    if (mutation.mode === "create" || mutation.mode === "continue") {
      return this.createIssueComment(
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

function findHandoffComments(
  issue: GithubIssueSnapshot,
  marker: string,
): GithubIssueSnapshot["comments"] {
  return issue.comments.filter((comment) =>
    comment.body.split(/\r?\n/u).includes(marker),
  );
}

function assertReusableHandoffComment(
  comment: GithubIssueSnapshot["comments"][number],
  expectedBody: string,
  expectedActorId: string,
): void {
  if (comment.body !== expectedBody || comment.author?.id !== expectedActorId) {
    throw new WorkpadNeedsInputError(
      "FailureReport handoff delivery marker conflicts with the configured template, handoff, or producer.",
    );
  }
}

/** Rechecks all optimistic-concurrency and lineage preconditions immediately before write. */
export function assertFreshWorkpadMutation(
  issue: GithubIssueSnapshot,
  mutation: IssueWorkpadMutation,
  producers: WorkpadProducerConfiguration,
  ignoreIssueTimestamp = false,
): void {
  if (
    !ignoreIssueTimestamp &&
    issue.updated_at !== mutation.expected_issue_updated_at
  ) {
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
    mutation.mode === "chunk" &&
    ((mutation.expected_workpad_revision === null && current) ||
      (mutation.expected_workpad_revision !== null &&
        (!current ||
          current.comment.id !== mutation.expected_workpad_comment_ref)))
  ) {
    throw new WorkpadPublicationRaceError(
      "Chunked FailureReport publication no longer has its verified predecessor head.",
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
