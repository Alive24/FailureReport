import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  appendFailureReportWorkpadEntry,
  diagnosticBranchSlugSchema,
  failureReportSchema,
  parseFailureReportWorkpad,
  renderFailureReportWorkpad,
  rootRequestSchema,
  rootResultSchema,
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
      workpad_marker: workpadMarker,
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

/** Covers durable-report parsing and v2 workpad serialization invariants. */
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
    expect(parsed.entries).toEqual([entry]);
  });

  it("appends a new entry while preserving every byte of the prior logical history", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const first = renderFailureReportWorkpad(entryFor(report, 0));
    const appended = appendFailureReportWorkpadEntry(
      first,
      entryFor(report, 1),
    );
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

  it("keeps Unicode diagnostic slugs runtime-validated without emitting an unsupported JSON Schema pattern", () => {
    expect(diagnosticBranchSlugSchema.parse("诊断-54")).toBe("诊断-54");
    expect(() => diagnosticBranchSlugSchema.parse("-diagnostic")).toThrow();
    expect(() => diagnosticBranchSlugSchema.parse("diagnostic_slug")).toThrow();

    const jsonSchema = JSON.stringify(z.toJSONSchema(failureReportSchema));

    expect(jsonSchema).not.toContain("\\p{");
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

  it("rejects legacy execution fields rather than silently accepting them", async () => {
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
        execution_state: { domain_id: "ckb" },
      }),
    ).toThrow();
    expect(() =>
      failureReportSchema.parse({
        ...report,
        target: { ...report.target, source_checkout_path: "/host/checkout" },
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
        target: { ...report.target, revision: undefined },
      }),
    ).toThrow();
    for (const revision of ["HEAD", "main"]) {
      expect(() =>
        failureReportSchema.parse({
          ...report,
          target: { ...report.target, revision },
        }),
      ).toThrow("full immutable Git SHA");
    }

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
          target: { ...report.target, [field]: value },
        }),
      ).toThrow();
    }
  });

  it("requires canonical extension sets and complete remote metadata for finalized diagnostics", async () => {
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
