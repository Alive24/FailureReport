import {
  appendFailureReportWorkpadEntry,
  failureReportSchema,
  githubIssueContextSchema,
  parseFailureReportWorkpad,
  renderFailureReportWorkpad,
  workpadMarker,
  type FailureReport,
  type FailureReportWorkpadEntry,
  type GithubIssueContext,
} from "@failure-report/protocol";

/**
 * Pure GitHub Issue workpad transformations and provenance checks.
 *
 * A GitHub marker is never enough to establish ownership. This module validates
 * a schema-valid v2 entry, the configured producer registry, and GitHub's live
 * immutable comment author before it treats any comment as FailureReport state.
 */

/** Immutable identity returned by GitHub for an account or App author. */
export type GithubActorIdentity = {
  id: string;
  login?: string;
  type?: string;
};

/** Minimal comment data needed to authenticate and parse a managed workpad. */
export type GithubIssueComment = {
  id: string;
  body: string;
  updated_at: string;
  author: GithubActorIdentity | null;
};

/** Immutable snapshot of an Issue used to prepare a guarded comment mutation. */
export type GithubIssueSnapshot = {
  repository: string;
  issue_number: number;
  title: string;
  issue_url: string;
  /** Human-owned Issue text. It is read only by this protocol. */
  body: string;
  updated_at: string;
  comments: GithubIssueComment[];
};

/** One explicitly configured producer allowed to write this workpad lineage. */
export type WorkpadProducer = {
  id: string;
  github_actor_id: string;
};

/**
 * Runtime producer registry. The current producer and every allowed successor
 * must be configured before Root can interpret or mutate a managed comment.
 */
export type WorkpadProducerConfiguration = {
  current: WorkpadProducer;
  producers: readonly WorkpadProducer[];
};

/** Explicit, fail-closed outcome used for unsafe workpad history. */
export class WorkpadNeedsInputError extends Error {
  readonly outcome = "needs_input";

  constructor(message: string) {
    super(message);
    this.name = "WorkpadNeedsInputError";
  }
}

/** A validated active comment at the head of the one permitted linear lineage. */
export type ExistingWorkpad = {
  comment: GithubIssueComment;
  report: FailureReport;
  revision: number;
  entry: FailureReportWorkpadEntry;
  logical_session_id: string;
  producer: WorkpadProducer;
  predecessor_comment_ref?: string;
};

/** A write prepared entirely in memory, with freshness values rechecked at write time. */
export type IssueWorkpadMutation = {
  mode: "create" | "append" | "continue";
  expected_issue_updated_at: string;
  expected_workpad_revision: number | null;
  expected_workpad_comment_ref?: string;
  workpad_comment_body: string;
  target_comment_ref?: string;
  predecessor_comment_ref?: string;
  entry: FailureReportWorkpadEntry;
  report: FailureReport;
};

type VerifiedWorkpadComment = {
  comment: GithubIssueComment;
  entries: FailureReportWorkpadEntry[];
  logical_session_id: string;
  producer: WorkpadProducer;
  predecessor_comment_ref?: string;
};

/**
 * Finds the head of exactly one schema-valid, provenance-verified comment lineage.
 * Any copied marker, legacy v1 payload, malformed entry, unknown producer, fork,
 * or incompatible successor is a deliberate `needs_input` outcome.
 */
export function findExistingWorkpad(
  issue: GithubIssueSnapshot,
  producers: WorkpadProducerConfiguration,
): ExistingWorkpad | undefined {
  const configuration = validateProducerConfiguration(producers);
  const verified = issue.comments
    .filter((comment) => comment.body.includes(workpadMarker))
    .map((comment) => verifyManagedComment(issue, comment, configuration));

  if (verified.length === 0) {
    return undefined;
  }

  const lineage = selectLinearLineage(verified);
  const head = lineage.at(-1);
  const entry = head?.entries.at(-1);
  if (!head || !entry) {
    throw new WorkpadNeedsInputError(
      "FailureReport workpad lineage has no selectable head entry.",
    );
  }
  return {
    comment: head.comment,
    report: entry.report,
    revision: entry.revision,
    entry,
    logical_session_id: head.logical_session_id,
    producer: head.producer,
    ...(head.predecessor_comment_ref
      ? { predecessor_comment_ref: head.predecessor_comment_ref }
      : {}),
  };
}

/**
 * Prepares a first entry, an immutable same-producer append, or a linked
 * successor comment for an explicitly configured producer change.
 */
export function prepareIssueWorkpadMutation(
  issue: GithubIssueSnapshot,
  report: FailureReport,
  syncedAt: string,
  producers: WorkpadProducerConfiguration,
): IssueWorkpadMutation {
  const configuration = validateProducerConfiguration(producers);
  const current = findExistingWorkpad(issue, configuration);
  const existingContext = report.shared_context;

  if (
    existingContext &&
    (existingContext.repository !== issue.repository ||
      existingContext.issue_number !== issue.issue_number)
  ) {
    throw new WorkpadNeedsInputError(
      "FailureReport is already bound to a different GitHub Issue.",
    );
  }
  if (!current && existingContext) {
    throw new WorkpadNeedsInputError(
      "FailureReport has shared context but no verified workpad lineage; reload requires input.",
    );
  }
  if (
    current &&
    existingContext &&
    existingContext.workpad_revision !== current.revision
  ) {
    throw new WorkpadNeedsInputError(
      "FailureReport workpad revision conflict; reload the Issue before writing.",
    );
  }
  if (
    current &&
    existingContext?.workpad_logical_session_id &&
    existingContext.workpad_logical_session_id !== current.logical_session_id
  ) {
    throw new WorkpadNeedsInputError(
      "FailureReport logical session conflict; reload the verified Issue lineage.",
    );
  }

  const sameProducer =
    current?.producer.github_actor_id === configuration.current.github_actor_id;
  const mode: IssueWorkpadMutation["mode"] = !current
    ? "create"
    : sameProducer
      ? "append"
      : "continue";
  const revision = current ? current.revision + 1 : 0;
  const logicalSessionId =
    current?.logical_session_id ?? initialLogicalSessionId(issue, report);
  const predecessorCommentRef =
    mode === "continue"
      ? current?.comment.id
      : current?.predecessor_comment_ref;
  const entryId = logicalSessionId + "/revision-" + String(revision);
  const targetCommentRef = mode === "append" ? current?.comment.id : undefined;
  const sharedContext: GithubIssueContext = githubIssueContextSchema.parse({
    provider: "github_issue",
    repository: issue.repository,
    issue_number: issue.issue_number,
    issue_url: issue.issue_url,
    workpad_marker: workpadMarker,
    ...(targetCommentRef ? { workpad_comment_ref: targetCommentRef } : {}),
    workpad_revision: revision,
    workpad_logical_session_id: logicalSessionId,
    workpad_entry_id: entryId,
    workpad_producer_id: configuration.current.id,
    ...(predecessorCommentRef
      ? { workpad_predecessor_comment_ref: predecessorCommentRef }
      : {}),
    synced_at: syncedAt,
  });
  const nextReport = failureReportSchema.parse({
    ...report,
    updated_at: syncedAt,
    shared_context: sharedContext,
  });
  const entry: FailureReportWorkpadEntry = {
    schema_version: "failure-report-workpad-entry/v2",
    producer: configuration.current,
    logical_session_id: logicalSessionId,
    entry_id: entryId,
    revision,
    ...(predecessorCommentRef
      ? { predecessor_comment_ref: predecessorCommentRef }
      : {}),
    report: nextReport,
  };

  const workpadCommentBody =
    mode === "append" && current
      ? appendFailureReportWorkpadEntry(current.comment.body, entry)
      : renderFailureReportWorkpad(entry);

  return {
    mode,
    expected_issue_updated_at: issue.updated_at,
    expected_workpad_revision: current?.revision ?? null,
    ...(current ? { expected_workpad_comment_ref: current.comment.id } : {}),
    workpad_comment_body: workpadCommentBody,
    ...(targetCommentRef ? { target_comment_ref: targetCommentRef } : {}),
    ...(predecessorCommentRef
      ? { predecessor_comment_ref: predecessorCommentRef }
      : {}),
    entry,
    report: nextReport,
  };
}

/** Revalidates a marked comment's content, binding, producer registry, and author. */
function verifyManagedComment(
  issue: GithubIssueSnapshot,
  comment: GithubIssueComment,
  configuration: WorkpadProducerConfiguration,
): VerifiedWorkpadComment {
  let entries: FailureReportWorkpadEntry[];
  try {
    entries = parseFailureReportWorkpad(comment.body).entries;
  } catch (error) {
    throw asNeedsInput(
      "FailureReport marker on comment " +
        comment.id +
        " is not a valid v2 entry envelope.",
      error,
    );
  }

  const first = entries[0];
  if (!first) {
    throw new WorkpadNeedsInputError(
      "FailureReport marker on comment " + comment.id + " has no entry.",
    );
  }
  const predecessor = first.predecessor_comment_ref;
  const entryIds = new Set<string>();
  let previousRevision: number | undefined;
  for (const entry of entries) {
    if (entry.report.id !== first.report.id) {
      throw new WorkpadNeedsInputError(
        "FailureReport comment " + comment.id + " mixes report identities.",
      );
    }
    if (entry.logical_session_id !== first.logical_session_id) {
      throw new WorkpadNeedsInputError(
        "FailureReport comment " + comment.id + " mixes logical sessions.",
      );
    }
    if (
      entry.producer.id !== first.producer.id ||
      entry.producer.github_actor_id !== first.producer.github_actor_id
    ) {
      throw new WorkpadNeedsInputError(
        "FailureReport comment " + comment.id + " mixes producer identities.",
      );
    }
    if (entry.predecessor_comment_ref !== predecessor) {
      throw new WorkpadNeedsInputError(
        "FailureReport comment " +
          comment.id +
          " has incompatible predecessor references.",
      );
    }
    if (entryIds.has(entry.entry_id)) {
      throw new WorkpadNeedsInputError(
        "FailureReport comment " + comment.id + " repeats an entry identity.",
      );
    }
    entryIds.add(entry.entry_id);
    if (
      previousRevision !== undefined &&
      entry.revision !== previousRevision + 1
    ) {
      throw new WorkpadNeedsInputError(
        "FailureReport comment " +
          comment.id +
          " has a non-contiguous revision history.",
      );
    }
    previousRevision = entry.revision;
    assertEntryBoundToIssue(entry, issue, comment.id);
  }

  const registered = configuration.producers.find(
    (producer) => producer.id === first.producer.id,
  );
  if (
    !registered ||
    registered.github_actor_id !== first.producer.github_actor_id
  ) {
    throw new WorkpadNeedsInputError(
      "FailureReport comment " + comment.id + " names an unknown producer.",
    );
  }
  if (!comment.author || comment.author.id !== registered.github_actor_id) {
    throw new WorkpadNeedsInputError(
      "FailureReport comment " +
        comment.id +
        " author does not match its recorded producer.",
    );
  }

  return {
    comment,
    entries,
    logical_session_id: first.logical_session_id,
    producer: registered,
    ...(predecessor ? { predecessor_comment_ref: predecessor } : {}),
  };
}

/** Selects the only valid root-to-head chain and rejects any fork or gap. */
function selectLinearLineage(
  comments: VerifiedWorkpadComment[],
): VerifiedWorkpadComment[] {
  const sessions = new Set(
    comments.map((comment) => comment.logical_session_id),
  );
  if (sessions.size !== 1) {
    throw new WorkpadNeedsInputError(
      "FailureReport workpad candidates have incompatible logical sessions.",
    );
  }
  const reports = new Set(
    comments.map((comment) => comment.entries[0]?.report.id).filter(Boolean),
  );
  if (reports.size !== 1) {
    throw new WorkpadNeedsInputError(
      "FailureReport workpad candidates have incompatible report identities.",
    );
  }

  const byId = new Map(
    comments.map((comment) => [comment.comment.id, comment]),
  );
  const roots = comments.filter((comment) => !comment.predecessor_comment_ref);
  if (roots.length !== 1) {
    throw new WorkpadNeedsInputError(
      "FailureReport workpad must have exactly one root comment.",
    );
  }
  const children = new Map<string, VerifiedWorkpadComment>();
  for (const comment of comments) {
    const predecessor = comment.predecessor_comment_ref;
    if (!predecessor) {
      continue;
    }
    const parent = byId.get(predecessor);
    if (!parent || parent === comment) {
      throw new WorkpadNeedsInputError(
        "FailureReport workpad has a missing or self-referential predecessor.",
      );
    }
    if (parent.producer.github_actor_id === comment.producer.github_actor_id) {
      throw new WorkpadNeedsInputError(
        "FailureReport same-producer continuation must append to its existing comment.",
      );
    }
    if (children.has(predecessor)) {
      throw new WorkpadNeedsInputError(
        "FailureReport workpad lineage fork requires input.",
      );
    }
    children.set(predecessor, comment);
  }

  const lineage: VerifiedWorkpadComment[] = [];
  const seen = new Set<string>();
  let current = roots[0];
  while (current) {
    if (seen.has(current.comment.id)) {
      throw new WorkpadNeedsInputError(
        "FailureReport workpad lineage contains a cycle.",
      );
    }
    seen.add(current.comment.id);
    lineage.push(current);
    current = children.get(current.comment.id);
  }
  if (seen.size !== comments.length) {
    throw new WorkpadNeedsInputError(
      "FailureReport workpad lineage is disconnected or ambiguous.",
    );
  }

  let revision: number | undefined;
  const entryIds = new Set<string>();
  for (const comment of lineage) {
    for (const entry of comment.entries) {
      if (entryIds.has(entry.entry_id)) {
        throw new WorkpadNeedsInputError(
          "FailureReport workpad lineage repeats an immutable entry identity.",
        );
      }
      entryIds.add(entry.entry_id);
      if (revision === undefined) {
        if (entry.revision !== 0) {
          throw new WorkpadNeedsInputError(
            "FailureReport workpad root must start at revision zero.",
          );
        }
      } else if (entry.revision !== revision + 1) {
        throw new WorkpadNeedsInputError(
          "FailureReport workpad lineage has a revision gap or overlap.",
        );
      }
      revision = entry.revision;
    }
  }
  return lineage;
}

/** Ensures every serialized report remains bound to this exact Issue and entry. */
function assertEntryBoundToIssue(
  entry: FailureReportWorkpadEntry,
  issue: GithubIssueSnapshot,
  commentRef: string,
): void {
  const context = entry.report.shared_context;
  if (
    !context ||
    context.provider !== "github_issue" ||
    context.repository !== issue.repository ||
    context.issue_number !== issue.issue_number ||
    context.issue_url !== issue.issue_url ||
    context.workpad_marker !== workpadMarker ||
    context.workpad_revision !== entry.revision ||
    context.workpad_logical_session_id !== entry.logical_session_id ||
    context.workpad_entry_id !== entry.entry_id ||
    context.workpad_producer_id !== entry.producer.id ||
    context.workpad_predecessor_comment_ref !== entry.predecessor_comment_ref
  ) {
    throw new WorkpadNeedsInputError(
      "FailureReport entry in comment " +
        commentRef +
        " is not bound to this Issue lineage.",
    );
  }
  if (
    context.workpad_comment_ref &&
    context.workpad_comment_ref !== commentRef
  ) {
    throw new WorkpadNeedsInputError(
      "FailureReport entry in comment " +
        commentRef +
        " names a different active comment.",
    );
  }
}

/** Validates configured producer identities before any public write is prepared. */
export function validateProducerConfiguration(
  configuration: WorkpadProducerConfiguration,
): WorkpadProducerConfiguration {
  const producers = [...configuration.producers];
  if (
    !isProducerId(configuration.current.id) ||
    !/^\d+$/.test(configuration.current.github_actor_id)
  ) {
    throw new WorkpadNeedsInputError(
      "Current FailureReport workpad producer must have an immutable GitHub actor id.",
    );
  }
  if (producers.length === 0) {
    throw new WorkpadNeedsInputError(
      "FailureReport workpad producer registry is empty.",
    );
  }
  const ids = new Set<string>();
  const actors = new Set<string>();
  for (const producer of producers) {
    if (!isProducerId(producer.id) || !/^\d+$/.test(producer.github_actor_id)) {
      throw new WorkpadNeedsInputError(
        "FailureReport workpad producer registry contains an invalid actor identity.",
      );
    }
    if (ids.has(producer.id) || actors.has(producer.github_actor_id)) {
      throw new WorkpadNeedsInputError(
        "FailureReport workpad producer registry must have unique producer and actor identities.",
      );
    }
    ids.add(producer.id);
    actors.add(producer.github_actor_id);
  }
  const registeredCurrent = producers.find(
    (producer) => producer.id === configuration.current.id,
  );
  if (
    !registeredCurrent ||
    registeredCurrent.github_actor_id !== configuration.current.github_actor_id
  ) {
    throw new WorkpadNeedsInputError(
      "Current FailureReport producer is not explicitly registered.",
    );
  }
  return { current: registeredCurrent, producers };
}

function isProducerId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value);
}

/** Derives a stable logical session without exposing runtime-specific data. */
function initialLogicalSessionId(
  issue: GithubIssueSnapshot,
  report: FailureReport,
): string {
  return (
    "github-issue/" +
    issue.repository +
    "/" +
    String(issue.issue_number) +
    "/" +
    report.id
  );
}

function asNeedsInput(message: string, cause: unknown): WorkpadNeedsInputError {
  const detail = cause instanceof Error ? ": " + cause.message : "";
  return new WorkpadNeedsInputError(message + detail);
}
