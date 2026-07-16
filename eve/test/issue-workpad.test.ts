import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  findExistingWorkpad,
  prepareIssueWorkpadMutation,
  renderIssueBody,
  upsertIssueNarrative,
} from "../agent/lib/integrations/github/issue-workpad.js";
import {
  failureReportSchema,
  parseFailureReportWorkpad,
} from "@failure-report/protocol";

/** Loads a schema-validated report fixture instead of exposing raw JSON to tests. */
async function loadReport() {
  const file = new URL(
    "../../packages/protocol/test/fixtures/issue-54.json",
    import.meta.url,
  );
  return failureReportSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/** Minimal target Issue used to test pure narrative and workpad transformations. */
const issue = {
  repository: "Alive24/CKBoost",
  issue_number: 54,
  issue_url: "https://github.com/Alive24/CKBoost/issues/54",
  body: "# Existing Issue",
  updated_at: "2026-07-15T10:00:00Z",
  comments: [],
};

/** Covers the single-comment, revision-checked workpad protocol. */
describe("GitHub Issue workpad", () => {
  it("creates the first immutable-context workpad on a target Issue", async () => {
    const report = await loadReport();
    const mutation = prepareIssueWorkpadMutation(
      issue,
      report,
      "2026-07-15T10:01:00Z",
    );
    const parsed = parseFailureReportWorkpad(mutation.workpad_comment_body);

    expect(mutation.mode).toBe("create");
    expect(mutation.expected_workpad_revision).toBeNull();
    expect(parsed.revision).toBe(0);
    expect(mutation.report.shared_context?.issue_number).toBe(54);
    expect(renderIssueBody(report)).toContain("Durable Workpad");
  });

  it("adds a stable narrative block without deleting existing Issue context", async () => {
    const report = await loadReport();
    const body = upsertIssueNarrative(
      "# Existing human context\n\nDo not erase.",
      report,
    );

    expect(body).toContain("Existing human context");
    expect(body).toContain("Do not erase.");
    expect(body).toContain("failure-report-issue:start");
    expect(upsertIssueNarrative(body, report)).toBe(body);
  });

  it("increments the single workpad revision on resume", async () => {
    const report = await loadReport();
    const first = prepareIssueWorkpadMutation(
      issue,
      report,
      "2026-07-15T10:01:00Z",
    );
    const resumedIssue = {
      ...issue,
      updated_at: "2026-07-15T10:02:00Z",
      comments: [
        {
          id: "IC_workpad_54",
          body: first.workpad_comment_body,
          updated_at: "2026-07-15T10:01:00Z",
        },
      ],
    };
    const second = prepareIssueWorkpadMutation(
      resumedIssue,
      first.report,
      "2026-07-15T10:03:00Z",
    );

    expect(findExistingWorkpad(resumedIssue)?.revision).toBe(0);
    expect(findExistingWorkpad(resumedIssue)?.report.id).toBe(report.id);
    expect(second.mode).toBe("update");
    expect(second.expected_workpad_revision).toBe(0);
    expect(
      parseFailureReportWorkpad(second.workpad_comment_body).revision,
    ).toBe(1);
  });

  it("rejects a stale report before it overwrites newer shared context", async () => {
    const report = await loadReport();
    const existing = prepareIssueWorkpadMutation(
      issue,
      report,
      "2026-07-15T10:01:00Z",
    );
    const later = prepareIssueWorkpadMutation(
      {
        ...issue,
        comments: [
          {
            id: "IC_workpad_54",
            body: existing.workpad_comment_body,
            updated_at: "2026-07-15T10:01:00Z",
          },
        ],
      },
      existing.report,
      "2026-07-15T10:02:00Z",
    );
    const issueAtRevisionOne = {
      ...issue,
      comments: [
        {
          id: "IC_workpad_54",
          body: later.workpad_comment_body,
          updated_at: "2026-07-15T10:02:00Z",
        },
      ],
    };

    expect(() =>
      prepareIssueWorkpadMutation(
        issueAtRevisionOne,
        existing.report,
        "2026-07-15T10:03:00Z",
      ),
    ).toThrow("revision conflict");
  });
});
