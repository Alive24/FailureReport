import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  failureReportSchema,
  parseFailureReportWorkpad,
  renderFailureReportWorkpad,
  workpadMarker,
} from "../src/index.js";

async function loadFixture(name: string): Promise<unknown> {
  const file = new URL("./fixtures/" + name, import.meta.url);
  return JSON.parse(await readFile(file, "utf8"));
}

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

  it("round-trips an Issue workpad without changing the report", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const markdown = renderFailureReportWorkpad(report, 7);
    const parsed = parseFailureReportWorkpad(markdown);

    expect(markdown).toContain(workpadMarker);
    expect(parsed.revision).toBe(7);
    expect(parsed.report).toEqual(report);
  });

  it("rejects a workpad header for a different report", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const markdown = renderFailureReportWorkpad(report, 1).replace(
      'report-id="' + report.id + '"',
      'report-id="another-report"',
    );

    expect(() => parseFailureReportWorkpad(markdown)).toThrow(
      "header does not match report id",
    );
  });

  it("validates GitHub Issue shared context", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const withIssue = failureReportSchema.parse({
      ...report,
      shared_context: {
        provider: "github_issue",
        repository: "Alive24/CKBoost",
        issue_number: 54,
        issue_url: "https://github.com/Alive24/CKBoost/issues/54",
        workpad_marker: workpadMarker,
        workpad_comment_ref: "IC_kwDO-test",
        workpad_revision: 3,
        synced_at: report.updated_at,
      },
    });

    expect(withIssue.shared_context?.workpad_revision).toBe(3);
  });

  it("keeps Codex execution state typed and outside shared Issue context", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const withExecution = failureReportSchema.parse({
      ...report,
      execution_state: {
        backend_id: "codex_app_server",
        codex_thread_id: "thr_ckb_54",
        worktree: {
          path: "/tmp/failure-report/ckb-54",
          identity: "ckb-issue-54",
          branch: "failure-report/ckb-issue-54",
          base_revision: report.target.revision,
          head_revision: report.target.revision,
        },
        last_execution_at: report.updated_at,
      },
    });

    expect(withExecution.execution_state?.codex_thread_id).toBe("thr_ckb_54");
    expect(withExecution.shared_context).toBeUndefined();
  });
});
