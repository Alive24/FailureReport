import { createHash } from "node:crypto";

import {
  diagnosticCompletionOutcomeSchema,
  diagnosticCompletionRecordSchema,
  failureReportSchema,
  type DiagnosticCompletionOutcome,
  type DiagnosticCompletionRecord,
  type DiagnosticSession,
  type FailureReport,
} from "@failure-report/protocol";

/**
 * Root-owned input for reconciling a completed Codex turn. The worker may
 * report evidence and recommendations, but this type deliberately contains no
 * GitHub location, revision, or mutation authority.
 */
export type DiagnosticCompletionInput = {
  codex_thread_id: string;
  outcome?: Partial<DiagnosticCompletionOutcome>;
  provider_finish_reason?: string;
};

/** The immutable pieces used to derive one replay-stable completion identity. */
export type DiagnosticCompletionIdentityInput = {
  report_id: string;
  target_revision: string;
  diagnostic_session_identity: string;
  codex_thread_id: string;
  observed_worktree_head: string;
};

/** A non-retryable integrity problem that Root must surface as `needs_input`. */
export class DiagnosticCompletionIntegrityError extends Error {
  readonly outcome = "needs_input";

  constructor(message: string) {
    super(message);
    this.name = "DiagnosticCompletionIntegrityError";
  }
}

/** A pure result for merging a validated completion into the latest report. */
export type DiagnosticCompletionProjection =
  | { status: "ok"; report: FailureReport }
  | { status: "needs_input"; reason: string };

/**
 * Creates a deterministic idempotency key without using a workpad revision or
 * completion timestamp. Those values change during ordinary publication races.
 */
export function createDiagnosticCompletionIdentity(
  input: DiagnosticCompletionIdentityInput,
): string {
  const binding = [
    "failure-report/diagnostic-completion/v1",
    input.report_id,
    input.target_revision,
    input.diagnostic_session_identity,
    input.codex_thread_id,
    input.observed_worktree_head,
  ].join("\u0000");
  return (
    "diagnostic-completion/" +
    createHash("sha256").update(binding).digest("hex")
  );
}

/**
 * Builds the Root-owned immutable record after the host has observed the
 * worktree. Its outcome is normalized so equivalent worker evidence does not
 * become a different record merely because arrays arrived in another order.
 */
export function createDiagnosticCompletionRecord(input: {
  report: FailureReport;
  diagnostic_session: DiagnosticSession;
  observed_worktree_head: string;
  completion: DiagnosticCompletionInput;
  completed_at: string;
}): DiagnosticCompletionRecord {
  const outcome = normalizeDiagnosticCompletionOutcome(
    input.completion.outcome,
  );
  const identity: DiagnosticCompletionIdentityInput = {
    report_id: input.report.id,
    target_revision: input.report.target.revision,
    diagnostic_session_identity: input.diagnostic_session.worktree.identity,
    codex_thread_id: input.completion.codex_thread_id,
    observed_worktree_head: input.observed_worktree_head,
  };

  try {
    return diagnosticCompletionRecordSchema.parse({
      schema_version: "failure-report/diagnostic-completion/v1",
      completion_id: createDiagnosticCompletionIdentity(identity),
      ...identity,
      outcome,
      metadata: {
        completed_at: input.completed_at,
        owner: "root",
        provider: "codex_app_server",
        ...(input.completion.provider_finish_reason
          ? { provider_finish_reason: input.completion.provider_finish_reason }
          : {}),
      },
    });
  } catch (error) {
    throw completionIntegrityError(
      "Diagnostic completion input is invalid",
      error,
    );
  }
}

/** Returns true when two completion records carry the same immutable payload. */
export function sameDiagnosticCompletion(
  left: DiagnosticCompletionRecord,
  right: DiagnosticCompletionRecord,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Validates already-persisted records before a new completion can be merged.
 * A malformed historical record is never repaired or replaced by this writer.
 */
export function validateDiagnosticCompletionHistory(
  report: FailureReport,
): string | undefined {
  const records = report.diagnostic_completions ?? [];
  const seen = new Set<string>();
  const session = report.diagnostic_session;

  for (const record of records) {
    if (seen.has(record.completion_id)) {
      return "FailureReport diagnostic completion history repeats an immutable completion identity.";
    }
    seen.add(record.completion_id);

    const expectedIdentity = createDiagnosticCompletionIdentity({
      report_id: record.report_id,
      target_revision: record.target_revision,
      diagnostic_session_identity: record.diagnostic_session_identity,
      codex_thread_id: record.codex_thread_id,
      observed_worktree_head: record.observed_worktree_head,
    });
    if (record.completion_id !== expectedIdentity) {
      return "FailureReport diagnostic completion identity does not match its immutable binding.";
    }
    if (record.report_id !== report.id) {
      return "FailureReport diagnostic completion belongs to a different report.";
    }
    if (record.target_revision !== report.target.revision) {
      return "FailureReport diagnostic completion targets a different immutable revision.";
    }
    if (
      !session ||
      record.diagnostic_session_identity !== session.worktree.identity
    ) {
      return "FailureReport diagnostic completion belongs to a different diagnostic session.";
    }
    if (session.codex_thread_id !== record.codex_thread_id) {
      return "FailureReport diagnostic completion does not match the persisted Codex thread.";
    }
  }
  return undefined;
}

/**
 * Projects a new completion into a fresh report without replacing unrelated
 * state. An identity collision with incompatible content is deliberately not a
 * merge conflict: it is an operator-visible integrity failure.
 */
export function projectDiagnosticCompletion(input: {
  report: FailureReport;
  diagnostic_session: DiagnosticSession;
  completion: DiagnosticCompletionRecord;
}): DiagnosticCompletionProjection {
  const historyProblem = validateDiagnosticCompletionHistory(input.report);
  if (historyProblem) {
    return { status: "needs_input", reason: historyProblem };
  }
  const records = input.report.diagnostic_completions ?? [];
  if (
    records.some(
      (record) => record.completion_id === input.completion.completion_id,
    )
  ) {
    return {
      status: "needs_input",
      reason:
        "FailureReport diagnostic completion identity is already present and must be reconciled before projection.",
    };
  }

  const evidence = mergeOwnedEntries(
    input.report.evidence,
    [
      ...input.completion.outcome.evidence,
      ...input.completion.outcome.operation_evidence,
    ],
    "evidence",
  );
  if (typeof evidence === "string") {
    return { status: "needs_input", reason: evidence };
  }
  const hypotheses = mergeOwnedEntries(
    input.report.hypotheses,
    input.completion.outcome.hypotheses,
    "hypothesis",
  );
  if (typeof hypotheses === "string") {
    return { status: "needs_input", reason: hypotheses };
  }
  const experiments = mergeOwnedEntries(
    input.report.experiments,
    input.completion.outcome.experiments,
    "experiment",
  );
  if (typeof experiments === "string") {
    return { status: "needs_input", reason: experiments };
  }

  const currentConclusion = input.report.conclusion;
  const nextConclusion = input.completion.outcome.conclusion;
  if (
    nextConclusion &&
    !sameJson(currentConclusion, nextConclusion) &&
    records.some((record) => record.outcome.conclusion)
  ) {
    return {
      status: "needs_input",
      reason:
        "A newer diagnostic completion already owns the report conclusion; refusing to overwrite it.",
    };
  }

  const requestedStatus = input.completion.outcome.report_status;
  if (
    requestedStatus &&
    requestedStatus !== input.report.status &&
    records.some((record) => record.outcome.report_status)
  ) {
    return {
      status: "needs_input",
      reason:
        "A newer diagnostic completion already owns the report status; refusing to overwrite it.",
    };
  }

  try {
    return {
      status: "ok",
      report: failureReportSchema.parse({
        ...input.report,
        ...(requestedStatus ? { status: requestedStatus } : {}),
        ...(nextConclusion ? { conclusion: nextConclusion } : {}),
        evidence,
        hypotheses,
        experiments,
        diagnostic_session: input.diagnostic_session,
        diagnostic_completions: [...records, input.completion],
      }),
    };
  } catch (error) {
    return {
      status: "needs_input",
      reason: completionIntegrityError(
        "Diagnostic completion could not be projected into the current report",
        error,
      ).message,
    };
  }
}

/** Normalizes optional Root input to the complete persisted outcome shape. */
function normalizeDiagnosticCompletionOutcome(
  outcome: Partial<DiagnosticCompletionOutcome> | undefined,
): DiagnosticCompletionOutcome {
  try {
    const parsed = diagnosticCompletionOutcomeSchema.parse({
      ...(outcome?.report_status
        ? { report_status: outcome.report_status }
        : {}),
      evidence: [...(outcome?.evidence ?? [])],
      operation_evidence: [...(outcome?.operation_evidence ?? [])],
      hypotheses: [...(outcome?.hypotheses ?? [])],
      experiments: [...(outcome?.experiments ?? [])],
      ...(outcome?.conclusion ? { conclusion: outcome.conclusion } : {}),
    });
    assertUniqueIds(parsed.evidence, "diagnostic evidence");
    assertUniqueIds(parsed.operation_evidence, "diagnostic operation evidence");
    assertUniqueIds(parsed.hypotheses, "diagnostic hypotheses");
    assertUniqueIds(parsed.experiments, "diagnostic experiments");
    const evidenceIds = new Set(parsed.evidence.map((evidence) => evidence.id));
    if (
      parsed.operation_evidence.some((evidence) => evidenceIds.has(evidence.id))
    ) {
      throw new DiagnosticCompletionIntegrityError(
        "Diagnostic completion repeats an evidence identity in both evidence and operation_evidence.",
      );
    }
    return {
      ...parsed,
      evidence: sortById(parsed.evidence),
      operation_evidence: sortById(parsed.operation_evidence),
      hypotheses: sortById(parsed.hypotheses),
      experiments: sortById(parsed.experiments),
    };
  } catch (error) {
    if (error instanceof DiagnosticCompletionIntegrityError) {
      throw error;
    }
    throw completionIntegrityError(
      "Diagnostic completion outcome is invalid",
      error,
    );
  }
}

/** Merges only additive owned fields and rejects incompatible identifiers. */
function mergeOwnedEntries<T extends { id: string }>(
  existing: readonly T[],
  additions: readonly T[],
  label: string,
): T[] | string {
  const merged = [...existing];
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  for (const addition of additions) {
    const prior = byId.get(addition.id);
    if (!prior) {
      byId.set(addition.id, addition);
      merged.push(addition);
      continue;
    }
    if (!sameJson(prior, addition)) {
      return (
        "Diagnostic completion " +
        label +
        " `" +
        addition.id +
        "` conflicts with newer report state."
      );
    }
  }
  return merged;
}

function assertUniqueIds(
  entries: readonly { id: string }[],
  label: string,
): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new DiagnosticCompletionIntegrityError(
        "Diagnostic completion repeats a " +
          label +
          " identity: `" +
          entry.id +
          "`.",
      );
    }
    ids.add(entry.id);
  }
}

function sortById<T extends { id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => left.id.localeCompare(right.id));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Stable JSON makes semantic object equality independent of property ordering. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function completionIntegrityError(
  message: string,
  cause: unknown,
): DiagnosticCompletionIntegrityError {
  const detail = cause instanceof Error ? ": " + cause.message : "";
  return new DiagnosticCompletionIntegrityError(message + detail);
}
