import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  failureReportSchema,
  parseFailureReportWorkpad,
  renderFailureReportWorkpad,
  rootRequestSchema,
  rootResultSchema,
  workpadMarker,
} from "../src/index.js";

/** Loads a raw fixture as unknown so each test exercises the production schema. */
async function loadFixture(name: string): Promise<unknown> {
  const file = new URL("./fixtures/" + name, import.meta.url);
  return JSON.parse(await readFile(file, "utf8"));
}

/** Covers durable-report parsing and workpad serialization invariants. */
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

  it("keeps multi-extension Codex diagnostic-session state typed and outside shared Issue context", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const withDiagnosticSession = failureReportSchema.parse({
      ...report,
      diagnostic_session: {
        lifecycle: "active",
        domain_extensions: ["ckb", "evm"],
        backend_id: "codex_app_server",
        codex_thread_id: "thr_ckb_54",
        worktree: {
          path: "/tmp/failure-report/ckb-54",
          identity: "issue-54",
          base_revision: report.target.revision,
          head_revision: report.target.revision,
        },
        diagnostic_branch_slug: "ckboost-issue-54",
        last_diagnosed_at: report.updated_at,
      },
    });

    expect(withDiagnosticSession.diagnostic_session?.codex_thread_id).toBe(
      "thr_ckb_54",
    );
    expect(withDiagnosticSession.diagnostic_session?.domain_extensions).toEqual(
      ["ckb", "evm"],
    );
    expect(withDiagnosticSession.shared_context).toBeUndefined();
  });

  it("rejects legacy execution fields rather than silently migrating a workpad", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );

    expect(() =>
      failureReportSchema.parse({
        ...report,
        diagnostic_session: {
          lifecycle: "active",
          domain_extensions: ["ckb"],
          domain_id: "ckb",
          backend_id: "codex_app_server",
          worktree: {
            path: "/tmp/failure-report/ckb-54",
            identity: "ckb-issue-54",
            branch: "failure-report/diagnostic/ckb/ckb-issue-54",
            base_revision: report.target.revision,
            head_revision: report.target.revision,
          },
          diagnostic_branch_slug: "ckboost-issue-54",
        },
      }),
    ).toThrow();
    expect(() =>
      failureReportSchema.parse({
        ...report,
        execution_state: {
          domain_id: "ckb",
        },
      }),
    ).toThrow();
    expect(() =>
      failureReportSchema.parse({
        ...report,
        target: {
          ...report.target,
          source_checkout_path: "/host/checkout",
        },
      }),
    ).toThrow();
  });

  it("requires an immutable SHA and rejects selectors or legacy checkout paths", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );

    expect(() =>
      failureReportSchema.parse({
        ...report,
        target: {
          ...report.target,
          revision: undefined,
        },
      }),
    ).toThrow();
    expect(() =>
      failureReportSchema.parse({
        ...report,
        target: {
          ...report.target,
          revision: "HEAD",
        },
      }),
    ).toThrow("full immutable Git SHA");
    expect(() =>
      failureReportSchema.parse({
        ...report,
        target: {
          ...report.target,
          revision: "main",
        },
      }),
    ).toThrow("full immutable Git SHA");

    for (const [field, value] of Object.entries({
      source_checkout_path: "/Volumes/Bohemialive/GitHub/CKBoost",
      cache_path: "/tmp/cache",
      worktree_path: "/tmp/worktree",
      branch: "main",
      cwd: "/tmp/worktree",
    })) {
      expect(() =>
        failureReportSchema.parse({
          ...report,
          target: {
            ...report.target,
            [field]: value,
          },
        }),
      ).toThrow();
    }
  });

  it("requires canonical extension sets and a branch for finalized diagnostics", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const worktree = {
      path: "/tmp/failure-report/issue-54",
      identity: "diagnostic-issue-54",
      base_revision: report.target.revision,
      head_revision: report.target.revision,
    };

    expect(() =>
      failureReportSchema.parse({
        ...report,
        diagnostic_session: {
          lifecycle: "active",
          domain_extensions: ["evm", "ckb"],
          backend_id: "codex_app_server",
          worktree,
          diagnostic_branch_slug: "ckboost-issue-54",
        },
      }),
    ).toThrow("domain_extensions must be unique and sorted");
    expect(() =>
      failureReportSchema.parse({
        ...report,
        diagnostic_session: {
          lifecycle: "finalized",
          domain_extensions: ["ckb"],
          backend_id: "codex_app_server",
          worktree,
          diagnostic_branch_slug: "ckboost-issue-54",
        },
      }),
    ).toThrow("requires a diagnostic_branch");

    expect(() =>
      failureReportSchema.parse({
        ...report,
        diagnostic_session: {
          lifecycle: "finalized",
          domain_extensions: ["ckb"],
          backend_id: "codex_app_server",
          worktree,
          diagnostic_branch_slug: "ckboost-issue-54",
          diagnostic_branch: {
            name: "diagnostic/54-ckboost-issue-54",
            head_revision: report.target.revision,
            finalized_at: report.updated_at,
            reuse_policy: "diagnostic_snapshot_only",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects the retired Root approval operation and result state", () => {
    const baseRequest = {
      request_id: "root-request-54",
      operation: "inspect",
      message: "Inspect the shared diagnostic context.",
    };

    expect(() =>
      rootRequestSchema.parse({
        ...baseRequest,
        operation: "submit_action_result",
      }),
    ).toThrow();
    expect(() =>
      rootRequestSchema.parse({
        ...baseRequest,
        action_result: { approved: true },
      }),
    ).toThrow();
    expect(() =>
      rootResultSchema.parse({
        request_id: baseRequest.request_id,
        status: "waiting_for_approval",
        summary: "Awaiting approval.",
      }),
    ).toThrow();
  });
});
