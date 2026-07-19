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
  workpadMarker,
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
  title: "CKBoost Issue 54",
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

  it("marks a finalized diagnostic branch as a snapshot rather than an implementation branch", async () => {
    const report = await loadReport();
    const finalized = failureReportSchema.parse({
      ...report,
      diagnostic_session: {
        lifecycle: "finalized",
        domain_extensions: ["ckb"],
        backend_id: "codex_app_server",
        worktree: {
          path: "/tmp/failure-report/issue-54",
          identity: "diagnostic-issue-54",
          base_revision: report.target.revision,
          head_revision: report.target.revision,
        },
        diagnostic_branch_slug: "ckboost-issue-54",
        diagnostic_branch: {
          name: "diagnostic/54-ckboost-issue-54",
          head_revision: report.target.revision,
          remote_name: "origin",
          remote_ref: "refs/heads/diagnostic/54-ckboost-issue-54",
          remote_url:
            "https://github.com/Alive24/CKBoost/tree/diagnostic/54-ckboost-issue-54",
          pushed_at: report.updated_at,
          finalized_at: report.updated_at,
          reuse_policy: "diagnostic_snapshot_only",
        },
      },
    });

    const narrative = renderIssueBody(finalized);
    expect(narrative).toContain("Diagnostic Snapshot");
    expect(narrative).toContain("Do not continue implementation");
    expect(narrative).toContain("separate implementation worktree/branch");
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

  it("repairs only a legacy active session missing its durable branch slug", async () => {
    const report = await loadReport();
    const active = failureReportSchema.parse({
      ...report,
      diagnostic_session: {
        lifecycle: "active",
        domain_extensions: ["ckb"],
        backend_id: "codex_app_server",
        worktree: {
          path: "/tmp/failure-report/issue-54",
          identity: "diagnostic-issue-54",
          base_revision: report.target.revision,
          head_revision: report.target.revision,
        },
        diagnostic_branch_slug: "old-title",
      },
    });
    const legacy = JSON.parse(JSON.stringify(active)) as {
      diagnostic_session: { diagnostic_branch_slug?: string };
    };
    delete legacy.diagnostic_session.diagnostic_branch_slug;
    const legacyWorkpad = [
      workpadMarker,
      '<!-- failure-report/v1 report-id="' + active.id + '" revision="9" -->',
      "~~~json",
      JSON.stringify({ failure_report: legacy }, null, 2),
      "~~~",
      "",
    ].join("\n");
    const legacyIssue = {
      ...issue,
      title: "Fix: CKB #54 — Node RPC",
      comments: [
        {
          id: "IC_workpad_54",
          body: legacyWorkpad,
          updated_at: "2026-07-15T10:01:00Z",
        },
      ],
    };

    expect(() => parseFailureReportWorkpad(legacyWorkpad)).toThrow(
      "diagnostic_branch_slug",
    );

    const existing = findExistingWorkpad(legacyIssue);
    expect(existing?.diagnostic_branch_slug_migrated).toBe(true);
    expect(existing?.report.diagnostic_session?.diagnostic_branch_slug).toBe(
      "fix-ckb-54-node-rpc",
    );
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
