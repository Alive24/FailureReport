import {
  failureReportSchema,
  githubIssueContextSchema,
  parseFailureReportWorkpad,
  renderFailureReportWorkpad,
  workpadMarker,
  type FailureReport,
  type GithubIssueContext,
} from "@failure-report/protocol";

export type GithubIssueComment = {
  id: string;
  body: string;
  updated_at: string;
};

export type GithubIssueSnapshot = {
  repository: string;
  issue_number: number;
  issue_url: string;
  body: string;
  updated_at: string;
  comments: GithubIssueComment[];
};

export type IssueWorkpadMutation = {
  mode: "create" | "update";
  expected_issue_updated_at: string;
  expected_workpad_revision: number | null;
  workpad_comment_ref?: string;
  workpad_comment_body: string;
  report: FailureReport;
};

export const issueNarrativeStartMarker = "<!-- failure-report-issue:start -->";
export const issueNarrativeEndMarker = "<!-- failure-report-issue:end -->";

export type ExistingWorkpad = {
  comment: GithubIssueComment;
  report: FailureReport;
  revision: number;
};

export function renderIssueBody(report: FailureReport): string {
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
    "## Durable Workpad",
    "The canonical structured FailureReport snapshot is maintained in the single",
    "comment marked `" + workpadMarker + "`. Large or sensitive evidence stays",
    "outside this Issue and is referenced from the workpad.",
    issueNarrativeEndMarker,
    "",
  ].join("\n");
}

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

  const workpad = parseFailureReportWorkpad(comment.body);
  return {
    comment,
    report: workpad.report,
    revision: workpad.revision,
  };
}

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
