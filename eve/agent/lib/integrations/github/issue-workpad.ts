import {
  diagnosticBranchSlugFor,
  failureReportSchema,
  githubIssueContextSchema,
  parseFailureReportWorkpad,
  renderFailureReportWorkpad,
  workpadMarker,
  type FailureReport,
  type GithubIssueContext,
} from "@failure-report/protocol";

/**
 * Pure GitHub Issue narrative/workpad transformations.
 *
 * Keeping these operations side-effect free lets the CLI gateway perform optimistic
 * concurrency checks immediately before it writes an Issue or comment.
 */

/** Minimal comment data needed to identify and parse a workpad. */
export type GithubIssueComment = {
  id: string;
  body: string;
  updated_at: string;
};

/** Immutable snapshot of the Issue state used to prepare a guarded mutation. */
export type GithubIssueSnapshot = {
  repository: string;
  issue_number: number;
  title: string;
  issue_url: string;
  body: string;
  updated_at: string;
  comments: GithubIssueComment[];
};

/**
 * A revision-checked Issue/body/comment update prepared without any GitHub write.
 * `expected_*` values are compared again by the gateway to prevent stale writers.
 */
export type IssueWorkpadMutation = {
  mode: "create" | "update";
  expected_issue_updated_at: string;
  expected_workpad_revision: number | null;
  workpad_comment_ref?: string;
  workpad_comment_body: string;
  report: FailureReport;
};

/** Delimiters for the small human-readable narrative inserted into the Issue body. */
export const issueNarrativeStartMarker = "<!-- failure-report-issue:start -->";
export const issueNarrativeEndMarker = "<!-- failure-report-issue:end -->";

/** Parsed workpad comment paired with the durable report snapshot it carries. */
export type ExistingWorkpad = {
  comment: GithubIssueComment;
  report: FailureReport;
  revision: number;
  /** True when a legacy active session was repaired only in memory. */
  diagnostic_branch_slug_migrated: boolean;
};

/** Renders the concise human-facing Issue narrative for a structured report. */
export function renderIssueBody(report: FailureReport): string {
  const diagnosticBranch =
    report.diagnostic_session?.lifecycle === "finalized"
      ? report.diagnostic_session.diagnostic_branch
      : undefined;
  return [
    issueNarrativeStartMarker,
    "# Failure Report: " + report.id,
    "",
    "## Status",
    "- Status: `" + report.status + "`",
    "- Severity: `" + report.severity + "`",
    "- Target revision: `" + report.target.revision + "`",
    "",
    "## Observed Behavior",
    ...report.symptom.observed_behavior.map((item) => "- " + item),
    "",
    "## Expected Behavior",
    ...report.symptom.expected_behavior.map((item) => "- " + item),
    "",
    "## Current Conclusion",
    report.conclusion.diagnosis,
    "",
    ...(diagnosticBranch
      ? [
          "## Diagnostic Snapshot",
          "- Branch: `" + diagnosticBranch.name + "`",
          "- This is a diagnostic-only snapshot. Do not continue implementation or open a pull request from it.",
          "- A future coding agent must use a separate implementation worktree/branch and decide whether to reuse its findings.",
          "",
        ]
      : []),
    "## Durable Workpad",
    "The canonical structured FailureReport snapshot is maintained in the single",
    "comment marked `" + workpadMarker + "`. Large or sensitive evidence stays",
    "outside this Issue and is referenced from the workpad.",
    issueNarrativeEndMarker,
    "",
  ].join("\n");
}

/**
 * Inserts or replaces only FailureReport's marked narrative block.
 * Human-authored Issue content outside the markers is deliberately preserved.
 */
export function upsertIssueNarrative(
  existingBody: string,
  report: FailureReport,
): string {
  const narrative = renderIssueBody(report).trim();
  const start = existingBody.indexOf(issueNarrativeStartMarker);
  const end = existingBody.indexOf(issueNarrativeEndMarker);

  if (start === -1 && end === -1) {
    const prefix = existingBody.trimEnd();
    return prefix ? prefix + "\n\n" + narrative + "\n" : narrative + "\n";
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error("FailureReport Issue narrative markers are malformed.");
  }

  const after = end + issueNarrativeEndMarker.length;
  return existingBody.slice(0, start) + narrative + existingBody.slice(after);
}

/**
 * Finds the one valid workpad comment on an Issue.
 * Multiple matching comments are rejected rather than guessing which history is
 * authoritative.
 */
export function findExistingWorkpad(
  issue: GithubIssueSnapshot,
): ExistingWorkpad | undefined {
  const comments = issue.comments.filter((comment) =>
    comment.body.includes(workpadMarker),
  );

  if (comments.length > 1) {
    throw new Error(
      "A FailureReport Issue must have exactly one workpad comment, but found " +
        String(comments.length) +
        ".",
    );
  }

  const comment = comments[0];
  if (!comment) {
    return undefined;
  }

  let diagnosticBranchSlugMigrated = false;
  const workpad = parseFailureReportWorkpad(comment.body, {
    normalize_payload(payload) {
      const migrated = migrateLegacyDiagnosticBranchSlug(payload, issue.title);
      diagnosticBranchSlugMigrated = migrated.did_migrate;
      return migrated.payload;
    },
  });
  return {
    comment,
    report: workpad.report,
    revision: workpad.revision,
    diagnostic_branch_slug_migrated: diagnosticBranchSlugMigrated,
  };
}

/**
 * Repairs exactly one historical shape: an active diagnostic session created
 * before `diagnostic_branch_slug` became a durable field. All other malformed
 * state remains subject to the protocol's strict schema validation.
 */
function migrateLegacyDiagnosticBranchSlug(
  payload: unknown,
  issueTitle: string,
): { payload: unknown; did_migrate: boolean } {
  if (!isRecord(payload)) {
    return { payload, did_migrate: false };
  }
  const report = payload.failure_report;
  if (!isRecord(report)) {
    return { payload, did_migrate: false };
  }
  const session = report.diagnostic_session;
  if (
    !isRecord(session) ||
    session.lifecycle !== "active" ||
    Object.prototype.hasOwnProperty.call(session, "diagnostic_branch_slug")
  ) {
    return { payload, did_migrate: false };
  }

  return {
    payload: {
      ...payload,
      failure_report: {
        ...report,
        diagnostic_session: {
          ...session,
          diagnostic_branch_slug: diagnosticBranchSlugFor(issueTitle),
        },
      },
    },
    did_migrate: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Prepares a new report revision and the matching Issue/workpad mutation.
 * This function performs no I/O so callers can retry safely after a freshness check.
 */
export function prepareIssueWorkpadMutation(
  issue: GithubIssueSnapshot,
  report: FailureReport,
  syncedAt: string,
): IssueWorkpadMutation {
  const current = findExistingWorkpad(issue);
  const existingContext = report.shared_context;

  if (
    existingContext &&
    (existingContext.repository !== issue.repository ||
      existingContext.issue_number !== issue.issue_number)
  ) {
    throw new Error(
      "FailureReport is already bound to a different GitHub Issue.",
    );
  }

  if (
    current &&
    existingContext &&
    existingContext.workpad_revision !== current.revision
  ) {
    throw new Error(
      "FailureReport workpad revision conflict; reload the Issue before writing.",
    );
  }

  const nextRevision = current ? current.revision + 1 : 0;
  // The workpad revision is written into both context and payload so a resume can
  // detect a stale report before it overwrites newer shared evidence.
  const sharedContext: GithubIssueContext = githubIssueContextSchema.parse({
    provider: "github_issue",
    repository: issue.repository,
    issue_number: issue.issue_number,
    issue_url: issue.issue_url,
    workpad_marker: workpadMarker,
    workpad_comment_ref: current?.comment.id,
    workpad_revision: nextRevision,
    synced_at: syncedAt,
  });
  const nextReport = failureReportSchema.parse({
    ...report,
    updated_at: syncedAt,
    shared_context: sharedContext,
  });

  return {
    mode: current ? "update" : "create",
    expected_issue_updated_at: issue.updated_at,
    expected_workpad_revision: current?.revision ?? null,
    workpad_comment_ref: current?.comment.id,
    workpad_comment_body: renderFailureReportWorkpad(nextReport, nextRevision),
    report: nextReport,
  };
}
