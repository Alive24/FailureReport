import {
  appendFailureReportWorkpadEntry,
  createFailureReportWorkpadChunkGroup,
  failureReportSchema,
  githubIssueContextSchema,
  parseFailureReportWorkpadChunk,
  parseFailureReportWorkpadManifest,
  parseFailureReportWorkpad,
  reconstructFailureReportWorkpadManifest,
  renderFailureReportWorkpadManifest,
  renderFailureReportWorkpad,
  serializeFailureReportWorkpadEntryPayload,
  workpadChunkMarker,
  workpadManifestStartMarker,
  workpadMarker,
  type FailureReport,
  type FailureReportWorkpadChunk,
  type FailureReportWorkpadChunkGroup,
  type FailureReportWorkpadEntry,
  type FailureReportWorkpadManifest,
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
  continuation_kind?: "capacity" | "producer_transition";
  representation: "entries" | "manifest";
};

type IssueWorkpadMutationBase = {
  expected_issue_updated_at: string;
  expected_workpad_revision: number | null;
  expected_workpad_comment_ref?: string;
  predecessor_comment_ref?: string;
  entry: FailureReportWorkpadEntry;
  report: FailureReport;
};

/** A single provider request for the normal entry or successor fast path. */
export type SingleCommentWorkpadMutation = IssueWorkpadMutationBase & {
  mode: "create" | "append" | "continue";
  workpad_comment_body: string;
  target_comment_ref?: string;
};

/** One provisional chunk write, optionally resolved to an immutable retry reuse. */
export type PlannedWorkpadChunk = {
  chunk: FailureReportWorkpadChunk;
  workpad_comment_body: string;
  existing_comment_ref?: string;
};

/** Multi-request publication whose final manifest is the only lineage mutation. */
export type ChunkedWorkpadMutation = IssueWorkpadMutationBase & {
  mode: "chunk";
  group: FailureReportWorkpadChunkGroup;
  chunks: PlannedWorkpadChunk[];
  encoded_byte_budget: number;
};

/** A provider-bounded write plan prepared entirely in memory. */
export type IssueWorkpadMutation =
  SingleCommentWorkpadMutation | ChunkedWorkpadMutation;

type VerifiedWorkpadComment = {
  comment: GithubIssueComment;
  entries: FailureReportWorkpadEntry[];
  logical_session_id: string;
  producer: WorkpadProducer;
  predecessor_comment_ref?: string;
  continuation_kind?: "capacity" | "producer_transition";
  representation: "entries" | "manifest";
};

/** Conservative encoded JSON request budget beneath GitHub's comment limit. */
export const defaultGithubWorkpadEncodedByteBudget = 60_000;

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
    ...(head.continuation_kind
      ? { continuation_kind: head.continuation_kind }
      : {}),
    representation: head.representation,
  };
}

/**
 * Derives a complete, caller-safe Issue context from a freshly read snapshot.
 *
 * An Issue without a workpad is still a valid initial state. Its canonical
 * context has revision zero and no comment reference, while the caller can use
 * the separate workpad presence signal to distinguish it from a persisted
 * revision-zero comment.
 */
export function rehydrateGithubIssueContext(
  issue: GithubIssueSnapshot,
  workpad: ExistingWorkpad | undefined,
): GithubIssueContext {
  return githubIssueContextSchema.parse({
    provider: "github_issue",
    repository: issue.repository,
    issue_number: issue.issue_number,
    issue_url: issue.issue_url,
    workpad_marker: workpadMarker,
    ...(workpad
      ? {
          workpad_comment_ref: workpad.comment.id,
          workpad_logical_session_id: workpad.logical_session_id,
          workpad_entry_id: workpad.entry.entry_id,
          workpad_producer_id: workpad.producer.id,
          ...(workpad.predecessor_comment_ref
            ? {
                workpad_predecessor_comment_ref:
                  workpad.predecessor_comment_ref,
              }
            : {}),
        }
      : {}),
    workpad_revision: workpad?.revision ?? 0,
    ...(workpad?.report.shared_context?.synced_at
      ? { synced_at: workpad.report.shared_context.synced_at }
      : {}),
  });
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
  encodedByteBudget = defaultGithubWorkpadEncodedByteBudget,
): IssueWorkpadMutation {
  const configuration = validateProducerConfiguration(producers);
  if (!Number.isSafeInteger(encodedByteBudget) || encodedByteBudget < 1) {
    throw new WorkpadNeedsInputError(
      "FailureReport provider comment budget must be a positive encoded-byte count.",
    );
  }
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
  if (
    !current &&
    existingContext &&
    !isCanonicalUnpersistedContext(issue, existingContext)
  ) {
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
  const revision = current ? current.revision + 1 : 0;
  const logicalSessionId =
    current?.logical_session_id ?? initialLogicalSessionId(issue, report);
  const entryId = logicalSessionId + "/revision-" + String(revision);
  const common = {
    expected_issue_updated_at: issue.updated_at,
    expected_workpad_revision: current?.revision ?? null,
    ...(current ? { expected_workpad_comment_ref: current.comment.id } : {}),
  };

  if (current && sameProducer && current.representation === "entries") {
    const entry = buildWorkpadEntry({
      issue,
      report,
      syncedAt,
      producer: configuration.current,
      logicalSessionId,
      entryId,
      revision,
      targetCommentRef: current.comment.id,
      predecessorCommentRef: current.predecessor_comment_ref,
      continuationKind: current.continuation_kind,
    });
    const body = appendFailureReportWorkpadEntry(current.comment.body, entry);
    if (encodedWorkpadCommentRequestBytes(body) <= encodedByteBudget) {
      return {
        ...common,
        mode: "append",
        workpad_comment_body: body,
        target_comment_ref: current.comment.id,
        ...(current.predecessor_comment_ref
          ? { predecessor_comment_ref: current.predecessor_comment_ref }
          : {}),
        entry,
        report: entry.report,
      };
    }
  }

  const predecessorCommentRef = current?.comment.id;
  const continuationKind = current
    ? sameProducer
      ? ("capacity" as const)
      : ("producer_transition" as const)
    : undefined;
  const entry = buildWorkpadEntry({
    issue,
    report,
    syncedAt,
    producer: configuration.current,
    logicalSessionId,
    entryId,
    revision,
    predecessorCommentRef,
    continuationKind,
  });
  const body = renderFailureReportWorkpad(entry);
  if (encodedWorkpadCommentRequestBytes(body) <= encodedByteBudget) {
    return {
      ...common,
      mode: current ? "continue" : "create",
      workpad_comment_body: body,
      ...(predecessorCommentRef
        ? { predecessor_comment_ref: predecessorCommentRef }
        : {}),
      entry,
      report: entry.report,
    };
  }

  const chunkByteLength = largestFittingChunkByteLength(
    entry,
    encodedByteBudget,
  );
  const selected = selectReusableChunkGroup(
    issue,
    entry,
    chunkByteLength,
    configuration,
  );
  return {
    ...common,
    mode: "chunk",
    ...(predecessorCommentRef
      ? { predecessor_comment_ref: predecessorCommentRef }
      : {}),
    group: selected.group,
    chunks: selected.group.chunks.map((chunk, index) => ({
      chunk,
      workpad_comment_body: selected.group.chunk_comment_bodies[index] ?? "",
      ...(selected.commentRefs[index]
        ? { existing_comment_ref: selected.commentRefs[index] }
        : {}),
    })),
    encoded_byte_budget: encodedByteBudget,
    entry,
    report: entry.report,
  };
}

/**
 * Distinguishes the canonical revision-zero result of `read_shared_context`
 * from an orphaned or caller-invented persisted lineage. The former carries no
 * publication authority and is safe for the first Root-owned append.
 */
function isCanonicalUnpersistedContext(
  issue: GithubIssueSnapshot,
  context: GithubIssueContext,
): boolean {
  return (
    context.provider === "github_issue" &&
    context.repository === issue.repository &&
    context.issue_number === issue.issue_number &&
    context.issue_url === issue.issue_url &&
    context.workpad_marker === workpadMarker &&
    context.workpad_revision === 0 &&
    context.workpad_comment_ref === undefined &&
    context.workpad_logical_session_id === undefined &&
    context.workpad_entry_id === undefined &&
    context.workpad_producer_id === undefined &&
    context.workpad_predecessor_comment_ref === undefined &&
    context.synced_at === undefined
  );
}

type BuildWorkpadEntryInput = {
  issue: GithubIssueSnapshot;
  report: FailureReport;
  syncedAt: string;
  producer: WorkpadProducer;
  logicalSessionId: string;
  entryId: string;
  revision: number;
  targetCommentRef?: string;
  predecessorCommentRef?: string;
  continuationKind?: "capacity" | "producer_transition";
};

/** Constructs one entry after the physical target representation is known. */
function buildWorkpadEntry(
  input: BuildWorkpadEntryInput,
): FailureReportWorkpadEntry {
  const sharedContext: GithubIssueContext = githubIssueContextSchema.parse({
    provider: "github_issue",
    repository: input.issue.repository,
    issue_number: input.issue.issue_number,
    issue_url: input.issue.issue_url,
    workpad_marker: workpadMarker,
    ...(input.targetCommentRef
      ? { workpad_comment_ref: input.targetCommentRef }
      : {}),
    workpad_revision: input.revision,
    workpad_logical_session_id: input.logicalSessionId,
    workpad_entry_id: input.entryId,
    workpad_producer_id: input.producer.id,
    ...(input.predecessorCommentRef
      ? { workpad_predecessor_comment_ref: input.predecessorCommentRef }
      : {}),
    synced_at: input.syncedAt,
  });
  const nextReport = failureReportSchema.parse({
    ...input.report,
    updated_at: input.syncedAt,
    shared_context: sharedContext,
  });
  return {
    schema_version: "failure-report-workpad-entry/v2",
    producer: input.producer,
    logical_session_id: input.logicalSessionId,
    entry_id: input.entryId,
    revision: input.revision,
    ...(input.predecessorCommentRef
      ? { predecessor_comment_ref: input.predecessorCommentRef }
      : {}),
    ...(input.continuationKind
      ? { continuation_kind: input.continuationKind }
      : {}),
    report: nextReport,
  };
}

/** Measures the actual UTF-8 JSON request representation used by both gateways. */
export function encodedWorkpadCommentRequestBytes(body: string): number {
  return Buffer.byteLength(JSON.stringify({ body }), "utf8");
}

function largestFittingChunkByteLength(
  entry: FailureReportWorkpadEntry,
  encodedByteBudget: number,
): number {
  const payloadBytes = Buffer.byteLength(
    serializeFailureReportWorkpadEntryPayload(entry),
    "utf8",
  );
  let low = 1;
  let high = payloadBytes;
  let selected = 0;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const group = createFailureReportWorkpadChunkGroup(entry, candidate);
    const fits = group.chunk_comment_bodies.every(
      (body) => encodedWorkpadCommentRequestBytes(body) <= encodedByteBudget,
    );
    if (fits) {
      selected = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  if (selected === 0) {
    throw new WorkpadNeedsInputError(
      "FailureReport provider budget is too small for a provisional chunk envelope.",
    );
  }
  return selected;
}

function selectReusableChunkGroup(
  issue: GithubIssueSnapshot,
  entry: FailureReportWorkpadEntry,
  chunkByteLength: number,
  configuration: WorkpadProducerConfiguration,
): {
  group: FailureReportWorkpadChunkGroup;
  commentRefs: Array<string | undefined>;
} {
  const provisional = issue.comments.filter((comment) =>
    comment.body.includes(workpadChunkMarker),
  );
  for (let attempt = 0; attempt <= provisional.length; attempt += 1) {
    const group = createFailureReportWorkpadChunkGroup(
      entry,
      chunkByteLength,
      attempt,
    );
    const candidates = provisional.flatMap((comment) => {
      try {
        const chunk = parseFailureReportWorkpadChunk(comment.body);
        return chunk.group_id === group.group_id ? [{ comment, chunk }] : [];
      } catch {
        return [];
      }
    });
    const refs: Array<string | undefined> = Array.from({
      length: group.chunks.length,
    });
    let reusable = true;
    for (const candidate of candidates) {
      const expected = group.chunks[candidate.chunk.chunk_index];
      if (
        !expected ||
        refs[candidate.chunk.chunk_index] ||
        candidate.comment.author?.id !==
          configuration.current.github_actor_id ||
        JSON.stringify(candidate.chunk) !== JSON.stringify(expected) ||
        candidate.comment.body !==
          group.chunk_comment_bodies[candidate.chunk.chunk_index]
      ) {
        reusable = false;
        break;
      }
      refs[candidate.chunk.chunk_index] = candidate.comment.id;
    }
    if (reusable) {
      return { group, commentRefs: refs };
    }
  }
  throw new WorkpadNeedsInputError(
    "FailureReport could not allocate an unambiguous provisional chunk group.",
  );
}

/**
 * Rechecks the durable chunk comments and measures the final outbound manifest
 * only after the provider has assigned every physical comment reference.
 */
export function prepareVerifiedWorkpadManifest(
  issue: GithubIssueSnapshot,
  mutation: ChunkedWorkpadMutation,
  commentRefs: readonly string[],
  configuration: WorkpadProducerConfiguration,
): string {
  const validated = validateProducerConfiguration(configuration);
  if (
    commentRefs.length !== mutation.chunks.length ||
    new Set(commentRefs).size !== commentRefs.length
  ) {
    throw new WorkpadNeedsInputError(
      "FailureReport final manifest requires one unique reference per chunk.",
    );
  }
  for (const [index, commentRef] of commentRefs.entries()) {
    const matches = issue.comments.filter(
      (comment) => comment.id === commentRef,
    );
    const planned = mutation.chunks[index];
    if (
      matches.length !== 1 ||
      !planned ||
      matches[0]?.body !== planned.workpad_comment_body ||
      matches[0]?.author?.id !== validated.current.github_actor_id
    ) {
      throw new WorkpadNeedsInputError(
        "FailureReport final manifest cannot verify every planned provisional chunk.",
      );
    }
  }
  const body = renderFailureReportWorkpadManifest(mutation.group, commentRefs);
  if (encodedWorkpadCommentRequestBytes(body) > mutation.encoded_byte_budget) {
    throw new WorkpadNeedsInputError(
      "FailureReport final manifest exceeds the provider's safe encoded-byte budget.",
    );
  }
  const synthetic = {
    id: "__pending_manifest__",
    body,
    updated_at: issue.updated_at,
    author: { id: validated.current.github_actor_id },
  };
  const verified = verifyManifestComment(issue, synthetic, validated);
  if (verified.entries[0]?.entry_id !== mutation.entry.entry_id) {
    throw new WorkpadNeedsInputError(
      "FailureReport final manifest does not reconstruct the prepared entry.",
    );
  }
  return body;
}

/** Revalidates a marked comment's content, binding, producer registry, and author. */
function verifyManagedComment(
  issue: GithubIssueSnapshot,
  comment: GithubIssueComment,
  configuration: WorkpadProducerConfiguration,
): VerifiedWorkpadComment {
  if (comment.body.includes(workpadManifestStartMarker)) {
    return verifyManifestComment(issue, comment, configuration);
  }

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
    if (entry.continuation_kind !== first.continuation_kind) {
      throw new WorkpadNeedsInputError(
        "FailureReport comment " + comment.id + " mixes continuation intents.",
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
    ...(first.continuation_kind
      ? { continuation_kind: first.continuation_kind }
      : {}),
    representation: "entries",
  };
}

/** Resolves and verifies a manifest's referenced chunks before exposing its entry. */
function verifyManifestComment(
  issue: GithubIssueSnapshot,
  comment: GithubIssueComment,
  configuration: WorkpadProducerConfiguration,
): VerifiedWorkpadComment {
  let manifest: FailureReportWorkpadManifest;
  try {
    manifest = parseFailureReportWorkpadManifest(comment.body);
  } catch (error) {
    throw asNeedsInput(
      "FailureReport marker on comment " +
        comment.id +
        " is not a valid final manifest.",
      error,
    );
  }
  const registered = configuration.producers.find(
    (producer) => producer.id === manifest.producer.id,
  );
  if (
    !registered ||
    registered.github_actor_id !== manifest.producer.github_actor_id
  ) {
    throw new WorkpadNeedsInputError(
      "FailureReport manifest " + comment.id + " names an unknown producer.",
    );
  }
  if (!comment.author || comment.author.id !== registered.github_actor_id) {
    throw new WorkpadNeedsInputError(
      "FailureReport manifest " +
        comment.id +
        " author does not match its recorded producer.",
    );
  }

  const referenced = manifest.chunks.map((reference) => {
    const matches = issue.comments.filter(
      (candidate) => candidate.id === reference.comment_ref,
    );
    if (matches.length !== 1 || matches[0] === comment) {
      throw new WorkpadNeedsInputError(
        "FailureReport manifest " +
          comment.id +
          " has a missing, duplicated, or self-referential chunk.",
      );
    }
    const chunkComment = matches[0];
    if (
      !chunkComment?.author ||
      chunkComment.author.id !== registered.github_actor_id
    ) {
      throw new WorkpadNeedsInputError(
        "FailureReport manifest " +
          comment.id +
          " references a foreign-author chunk.",
      );
    }
    return { comment_ref: reference.comment_ref, body: chunkComment.body };
  });

  let entry: FailureReportWorkpadEntry;
  try {
    entry = reconstructFailureReportWorkpadManifest(manifest, referenced);
  } catch (error) {
    throw asNeedsInput(
      "FailureReport manifest " +
        comment.id +
        " cannot reconstruct one verified canonical payload.",
      error,
    );
  }
  assertEntryBoundToIssue(entry, issue, comment.id);
  return {
    comment,
    entries: [entry],
    logical_session_id: manifest.logical_session_id,
    producer: registered,
    ...(manifest.predecessor_comment_ref
      ? { predecessor_comment_ref: manifest.predecessor_comment_ref }
      : {}),
    ...(manifest.continuation_kind
      ? { continuation_kind: manifest.continuation_kind }
      : {}),
    representation: "manifest",
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
  if (roots[0]?.continuation_kind) {
    throw new WorkpadNeedsInputError(
      "FailureReport workpad root cannot declare continuation intent.",
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
    const sameProducer =
      parent.producer.github_actor_id === comment.producer.github_actor_id;
    if (sameProducer && comment.continuation_kind !== "capacity") {
      throw new WorkpadNeedsInputError(
        "FailureReport same-producer successor lacks an explicit capacity continuation.",
      );
    }
    if (
      !sameProducer &&
      comment.continuation_kind !== undefined &&
      comment.continuation_kind !== "producer_transition"
    ) {
      throw new WorkpadNeedsInputError(
        "FailureReport configured producer transition has incompatible continuation intent.",
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
