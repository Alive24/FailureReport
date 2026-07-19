import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  appendFailureReportWorkpadEntry,
  failureReportSchema,
  githubIssueSelectorSchema,
  parseFailureReportWorkpad,
  renderFailureReportWorkpad,
  rootRequestSchema,
  workpadMarker,
  type FailureReport,
  type FailureReportWorkpadEntry,
} from "../src/index.js";

/** Loads a raw fixture as unknown so every test exercises the production schema. */
async function loadFixture(name: string): Promise<unknown> {
  const file = new URL("./fixtures/" + name, import.meta.url);
  return JSON.parse(await readFile(file, "utf8"));
}

/** Builds a v2 entry whose report context agrees with its immutable envelope. */
function entryFor(
  report: FailureReport,
  revision: number,
  options: { predecessor_comment_ref?: string } = {},
): FailureReportWorkpadEntry {
  const logicalSessionId = "github-issue/Alive24/CKBoost/54/" + report.id;
  const entryId = logicalSessionId + "/revision-" + String(revision);
  const contextualReport = failureReportSchema.parse({
    ...report,
    shared_context: {
      provider: "github_issue",
      repository: "Alive24/CKBoost",
      issue_number: 54,
      issue_url: "https://github.com/Alive24/CKBoost/issues/54",
      workpad_marker: "<!-- failure-report-workpad -->",
      workpad_revision: revision,
      workpad_logical_session_id: logicalSessionId,
      workpad_entry_id: entryId,
      workpad_producer_id: "root-gh",
      ...(options.predecessor_comment_ref
        ? {
            workpad_predecessor_comment_ref: options.predecessor_comment_ref,
          }
        : {}),
      synced_at: report.updated_at,
    },
  });
  return {
    schema_version: "failure-report-workpad-entry/v2",
    producer: { id: "root-gh", github_actor_id: "101" },
    logical_session_id: logicalSessionId,
    entry_id: entryId,
    revision,
    ...(options.predecessor_comment_ref
      ? { predecessor_comment_ref: options.predecessor_comment_ref }
      : {}),
    report: contextualReport,
  };
}

/** Covers v2 envelope parsing, public presentation, and append-only rendering. */
describe("FailureReport protocol", () => {
  it.each(["issue-54.json", "contract-recipe-identifier.json"])(
    "accepts the historical CKBoost fixture %s",
    async (name) => {
      const report = failureReportSchema.parse(await loadFixture(name));

      expect(report.schema_version).toBe("failure-report/v1");
      expect(["ready", "ready_with_assumptions"]).toContain(
        report.handoff.todo_status,
      );
    },
  );

  it("round-trips a versioned managed entry with a human summary before details", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const entry = entryFor(report, 7);
    const markdown = renderFailureReportWorkpad(entry);
    const parsed = parseFailureReportWorkpad(markdown);

    expect(markdown.indexOf("### FailureReport update")).toBeLessThan(
      markdown.indexOf("<details>"),
    );
    expect(markdown).toContain("Canonical FailureReport snapshot");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toEqual(entry);
  });

  it("appends a new entry while preserving every byte of the prior logical history", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const first = renderFailureReportWorkpad(entryFor(report, 0));
    const second = entryFor(report, 1);
    const appended = appendFailureReportWorkpadEntry(first, second);
    const parsed = parseFailureReportWorkpad(appended);

    expect(appended.startsWith(first)).toBe(true);
    expect(parsed.entries.map((entry) => entry.revision)).toEqual([0, 1]);
    expect(parsed.entries[0]?.report).toEqual(entryFor(report, 0).report);
  });

  it("rejects legacy marker-only workpads rather than silently migrating them", () => {
    expect(() =>
      parseFailureReportWorkpad(
        '<!-- failure-report-workpad -->\n<!-- failure-report/v1 report-id="old" revision="0" -->',
      ),
    ).toThrow("legacy v1");
  });

  it("accepts a strictly minimal existing-Issue selector without weakening durable context validation", () => {
    const selector = githubIssueSelectorSchema.parse({
      repository: "Alive24/CKBoost",
      issue_number: 54,
    });
    const request = rootRequestSchema.parse({
      request_id: "existing-issue-selector",
      operation: "start",
      issue_selector: selector,
      message: "Start from the existing Issue.",
    });

    expect(request.issue_selector).toEqual(selector);
    expect(() =>
      githubIssueSelectorSchema.parse({
        repository: "not a repository",
        issue_number: 54,
      }),
    ).toThrow();
    expect(() =>
      githubIssueSelectorSchema.parse({
        repository: "Alive24/CKBoost",
        issue_number: 0,
      }),
    ).toThrow();
    for (const callerSuppliedContext of [
      { issue_url: "https://github.com/Alive24/CKBoost/issues/54" },
      { workpad_marker: workpadMarker },
      { workpad_comment_ref: "IC_workpad_54" },
      { workpad_revision: 0 },
    ]) {
      expect(() =>
        rootRequestSchema.parse({
          request_id: "selector-with-persisted-context",
          operation: "start",
          issue_selector: {
            repository: "Alive24/CKBoost",
            issue_number: 54,
            ...callerSuppliedContext,
          },
        }),
      ).toThrow();
    }
    expect(() =>
      rootRequestSchema.parse({
        request_id: "selector-and-context",
        operation: "start",
        issue_selector: selector,
        issue: {
          provider: "github_issue",
          repository: "Alive24/CKBoost",
          issue_number: 54,
          issue_url: "https://github.com/Alive24/CKBoost/issues/54",
          workpad_marker: workpadMarker,
          workpad_revision: 0,
        },
      }),
    ).toThrow("provide either issue_selector");
    expect(() =>
      rootRequestSchema.parse({
        request_id: "incomplete-durable-context",
        operation: "resume",
        issue: {
          provider: "github_issue",
          repository: "Alive24/CKBoost",
          issue_number: 54,
          workpad_marker: workpadMarker,
          workpad_revision: 0,
        },
      }),
    ).toThrow();
  });

  it("rejects credential-like text and prohibited host paths before public rendering", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const credentialBearing = failureReportSchema.parse({
      ...report,
      symptom: {
        ...report.symptom,
        raw_error_summary: "token=ghp_not-a-real-token",
      },
    });
    const hostPathBearing = failureReportSchema.parse({
      ...report,
      origin: { ...report.origin, reporter: "/Users/example/private-evidence" },
    });

    expect(() =>
      renderFailureReportWorkpad(entryFor(credentialBearing, 0)),
    ).toThrow("credential-like");
    expect(() =>
      renderFailureReportWorkpad(entryFor(hostPathBearing, 0)),
    ).toThrow("prohibited host path");
  });
});
