import { describe, expect, it } from "vitest";

import {
  buildDiagnosticStartRequest,
  isFreshRehydratedIssue,
} from "../scripts/root-codex-trace-capture.mjs";

const fixture = {
  repository: "example/project",
  issue_number: 55,
  revision: "a".repeat(40),
};

const freshIssue = {
  provider: "github_issue",
  repository: fixture.repository,
  issue_number: fixture.issue_number,
  issue_url: "https://example.invalid/issues/55",
  workpad_marker: "failure-report-workpad",
  workpad_revision: 0,
};

describe("fresh fixture diagnostic request", () => {
  it("identifies only a revision-zero context without managed lineage as fresh", () => {
    expect(isFreshRehydratedIssue(freshIssue)).toBe(true);
    expect(
      isFreshRehydratedIssue({
        ...freshIssue,
        workpad_comment_ref: "comment-1",
      }),
    ).toBe(false);
    expect(
      isFreshRehydratedIssue({
        ...freshIssue,
        workpad_revision: 1,
        workpad_logical_session_id: "session-1",
      }),
    ).toBe(false);
  });

  it("tells Root to let initial publication create fresh lineage", () => {
    const request = buildDiagnosticStartRequest(
      freshIssue,
      fixture,
      "request-1",
    );

    expect(request.issue).toBe(freshIssue);
    expect(request.message).toContain("Treat it as a fresh Issue");
    expect(request.message).toContain(
      "do not put failure_report.shared_context on the draft report",
    );
    expect(request.message).toContain(
      "initial publication must create the lineage",
    );
  });

  it("does not relabel existing managed lineage as fresh", () => {
    const request = buildDiagnosticStartRequest(
      {
        ...freshIssue,
        workpad_revision: 3,
        workpad_comment_ref: "comment-3",
        workpad_logical_session_id: "session-3",
        workpad_entry_id: "entry-3",
        workpad_producer_id: "producer-3",
      },
      fixture,
      "request-2",
    );

    expect(request.message).not.toContain("Treat it as a fresh Issue");
  });
});
