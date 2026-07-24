import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  appendFailureReportWorkpadEntry,
  failureReportSchema,
  renderFailureReportWorkpad,
  workpadMarker,
  type FailureReport,
  type FailureReportWorkpadEntry,
} from "@failure-report/protocol";

import { createDiagnosticHandoffRenderer } from "../agent/lib/diagnostics/handoff-renderer.js";
import type { GithubIssueGateway } from "../agent/lib/integrations/github/issue-gateway.js";
import type {
  GithubIssueSnapshot,
  WorkpadProducerConfiguration,
} from "../agent/lib/integrations/github/issue-workpad.js";

const producer: WorkpadProducerConfiguration = {
  current: { id: "root-gh", github_actor_id: "101" },
  producers: [{ id: "root-gh", github_actor_id: "101" }],
};

async function loadFixture(): Promise<FailureReport> {
  const file = new URL(
    "../../packages/protocol/test/fixtures/issue-54.json",
    import.meta.url,
  );
  return failureReportSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

async function readyReport(
  revision = 1,
  overrides: Record<string, unknown> = {},
): Promise<FailureReport> {
  const base = await loadFixture();
  const logicalSessionId = "github-issue/Alive24/CKBoost/54/" + base.id;
  const identity = "diagnostic-contract-54";
  return failureReportSchema.parse({
    ...base,
    shared_context: {
      provider: "github_issue",
      repository: "Alive24/CKBoost",
      issue_number: 54,
      issue_url: "https://github.com/Alive24/CKBoost/issues/54",
      workpad_marker: workpadMarker,
      workpad_comment_ref: "comment-54",
      workpad_revision: revision,
      workpad_logical_session_id: logicalSessionId,
      workpad_entry_id: logicalSessionId + "/revision-" + String(revision),
      workpad_producer_id: producer.current.id,
      synced_at: base.updated_at,
    },
    diagnostic_session: {
      lifecycle: "finalized",
      domain_extensions: ["ckb"],
      backend_id: "codex_app_server",
      codex_thread_id: "thread-contract-54",
      worktree: {
        path: "/root-owned/worktrees/diagnostic-contract-54",
        identity,
        base_revision: base.target.revision,
        head_revision: base.target.revision,
      },
      diagnostic_branch_slug: "contract-recipe",
      diagnostic_branch: {
        name: "diagnostic/54-contract-recipe",
        head_revision: base.target.revision,
        remote_name: "origin",
        remote_ref: "refs/heads/diagnostic/54-contract-recipe",
        remote_url:
          "https://github.com/Alive24/CKBoost/tree/diagnostic/54-contract-recipe",
        pushed_at: base.updated_at,
        finalized_at: base.updated_at,
        reuse_policy: "diagnostic_snapshot_only",
      },
    },
    diagnostic_completions: [
      {
        schema_version: "failure-report/diagnostic-completion/v1",
        completion_id: "diagnostic-completion/contract-54",
        report_id: base.id,
        target_revision: base.target.revision,
        diagnostic_session_identity: identity,
        codex_thread_id: "thread-contract-54",
        observed_worktree_head: base.target.revision,
        outcome: {
          evidence: [],
          operation_evidence: [],
          hypotheses: [],
          experiments: [],
        },
        metadata: {
          completed_at: base.updated_at,
          owner: "root",
          provider: "codex_app_server",
        },
      },
    ],
    ...overrides,
  });
}

async function humanInputReport(): Promise<FailureReport> {
  const report = await readyReport();
  const session = report.diagnostic_session;
  if (!session) {
    throw new Error("Fixture requires diagnostic state.");
  }
  return failureReportSchema.parse({
    ...report,
    status: "needs_input",
    conclusion: {
      ...report.conclusion,
      remaining_uncertainty: [
        "The canonical identifier choice remains a product decision.",
      ],
    },
    diagnostic_completions: undefined,
    diagnostic_session: {
      ...session,
      lifecycle: "active",
      diagnostic_branch: undefined,
    },
    handoff: {
      ...report.handoff,
      todo_status: "not_ready",
      gate_decision: "Need to Clarify",
      residual_risks: [],
      human_input: {
        remaining_material_unknown:
          "The canonical identifier choice remains a product decision.",
        viable_options: [
          "Keep the qualified public identifier.",
          "Adopt the unqualified internal identifier.",
        ],
        question:
          "Which identifier must remain canonical for public protocol calls?",
        resume_condition:
          "Resume the same diagnostic session after the protocol owner selects one identifier.",
      },
    },
  });
}

function managedIssue(
  report: FailureReport,
  options: {
    issue_updated_at?: string;
    comment_updated_at?: string;
    comment_id?: string;
  } = {},
): GithubIssueSnapshot {
  const context = report.shared_context;
  if (!context?.workpad_logical_session_id || !context.workpad_entry_id) {
    throw new Error("Fixture requires a persisted workpad identity.");
  }
  const entries: FailureReportWorkpadEntry[] = Array.from(
    { length: context.workpad_revision + 1 },
    (_, revision) => {
      const entryId =
        context.workpad_logical_session_id + "/revision-" + String(revision);
      return {
        schema_version: "failure-report-workpad-entry/v2",
        producer: producer.current,
        logical_session_id: context.workpad_logical_session_id,
        entry_id: entryId,
        revision,
        report: failureReportSchema.parse({
          ...report,
          shared_context: {
            ...context,
            workpad_revision: revision,
            workpad_entry_id: entryId,
          },
        }),
      };
    },
  );
  const first = entries[0];
  if (!first) {
    throw new Error("Fixture requires at least one workpad entry.");
  }
  const body = entries
    .slice(1)
    .reduce(
      (markdown, entry) => appendFailureReportWorkpadEntry(markdown, entry),
      renderFailureReportWorkpad(first),
    );
  return {
    repository: context.repository,
    issue_number: context.issue_number,
    title: "Contract recipe identifier",
    issue_url: context.issue_url,
    body: "Human-owned Issue body.",
    updated_at: options.issue_updated_at ?? "2026-07-20T10:00:00Z",
    comments: [
      {
        id: options.comment_id ?? "comment-54",
        body,
        updated_at: options.comment_updated_at ?? "2026-07-20T10:00:00Z",
        author: { id: producer.current.github_actor_id, login: "root" },
      },
    ],
  };
}

function rendererHarness(reads: GithubIssueSnapshot[]) {
  const readIssue = vi.fn(async () => {
    const next = reads.shift();
    if (!next) {
      throw new Error("Unexpected extra Issue read.");
    }
    return next;
  });
  const publishSharedContext = vi.fn(async () => {
    throw new Error("read-only renderer must never publish");
  });
  const gateway = {
    readIssue,
    publishSharedContext,
    getWorkpadProducerConfiguration: () => producer,
  } satisfies GithubIssueGateway;
  return {
    render: createDiagnosticHandoffRenderer({ gateway }),
    readIssue,
    publishSharedContext,
  };
}

function requestFor(report: FailureReport) {
  const context = report.shared_context;
  if (!context?.workpad_logical_session_id || !context.workpad_entry_id) {
    throw new Error("Fixture requires a persisted workpad identity.");
  }
  return {
    report_id: report.id,
    repository: context.repository,
    issue_number: context.issue_number,
    expected_workpad_revision: context.workpad_revision,
    expected_workpad_logical_session_id: context.workpad_logical_session_id,
    expected_workpad_entry_id: context.workpad_entry_id,
    expected_target_revision: report.target.revision,
  };
}

describe("Root diagnostic handoff renderer", () => {
  it("rehydrates the verified latest workpad and renders without any mutation", async () => {
    const report = await readyReport();
    const issue = managedIssue(report);
    const harness = rendererHarness([issue, issue]);

    const result = await harness.render(requestFor(report));

    expect(result.status).toBe("completed");
    expect(result).toHaveProperty(
      "implementation_handoff.schema_version",
      "failure-report/implementation-handoff/v1",
    );
    expect(harness.readIssue).toHaveBeenCalledTimes(2);
    expect(harness.publishSharedContext).not.toHaveBeenCalled();
  });

  it("rejects stale caller revisions and target mismatches instead of trusting caller report content", async () => {
    const report = await readyReport();
    const issue = managedIssue(report);
    const staleHarness = rendererHarness([issue]);
    const mismatchedHarness = rendererHarness([issue]);

    const stale = await staleHarness.render({
      ...requestFor(report),
      expected_workpad_revision: 0,
    });
    const mismatched = await mismatchedHarness.render({
      ...requestFor(report),
      expected_target_revision: "f".repeat(40),
    });

    expect(stale).toMatchObject({ status: "needs_input" });
    expect(stale).toHaveProperty("reason", expect.stringContaining("stale"));
    expect(mismatched).toMatchObject({ status: "needs_input" });
    expect(mismatched).toHaveProperty(
      "reason",
      expect.stringContaining("target revision"),
    );
    expect(staleHarness.publishSharedContext).not.toHaveBeenCalled();
    expect(mismatchedHarness.publishSharedContext).not.toHaveBeenCalled();
  });

  it("rejects a concurrent managed-workpad change during rendering", async () => {
    const report = await readyReport();
    const advanced = await readyReport(2);
    const harness = rendererHarness([
      managedIssue(report),
      managedIssue(advanced, {
        issue_updated_at: "2026-07-20T10:01:00Z",
        comment_updated_at: "2026-07-20T10:01:00Z",
      }),
    ]);

    const result = await harness.render(requestFor(report));

    expect(result).toMatchObject({ status: "needs_input" });
    expect(result).toHaveProperty(
      "reason",
      expect.stringContaining("concurrently"),
    );
    expect(harness.publishSharedContext).not.toHaveBeenCalled();
  });

  it("rejects incomplete finalization and conflicting snapshot references", async () => {
    const report = await readyReport();
    const session = report.diagnostic_session;
    if (!session?.diagnostic_branch) {
      throw new Error("Fixture requires a finalized branch.");
    }
    const conflicting = failureReportSchema.parse({
      ...report,
      diagnostic_session: {
        ...session,
        diagnostic_branch: {
          ...session.diagnostic_branch,
          remote_ref: "refs/heads/diagnostic/54-wrong",
        },
      },
    });
    const active = failureReportSchema.parse({
      ...report,
      diagnostic_completions: undefined,
      diagnostic_session: {
        ...session,
        lifecycle: "active",
        diagnostic_branch: undefined,
      },
    });
    const conflictingHarness = rendererHarness([managedIssue(conflicting)]);
    const activeHarness = rendererHarness([managedIssue(active)]);

    const result = await conflictingHarness.render(requestFor(conflicting));
    const incomplete = await activeHarness.render(requestFor(active));

    expect(result).toMatchObject({ status: "needs_input" });
    expect(result).toHaveProperty(
      "reason",
      expect.stringContaining("snapshot references conflict"),
    );
    expect(incomplete).toMatchObject({ status: "needs_input" });
    expect(incomplete).toHaveProperty(
      "reason",
      expect.stringContaining("finalized diagnostic session"),
    );
    expect(conflictingHarness.publishSharedContext).not.toHaveBeenCalled();
    expect(activeHarness.publishSharedContext).not.toHaveBeenCalled();
  });

  it("returns needs_input for a conflicting managed-workpad lineage", async () => {
    const report = await readyReport();
    const issue = managedIssue(report);
    const conflictingReport = failureReportSchema.parse({
      ...report,
      shared_context: {
        ...report.shared_context!,
        workpad_comment_ref: "comment-conflicting-root",
      },
    });
    const conflicting = {
      ...issue,
      comments: [
        ...issue.comments,
        ...managedIssue(conflictingReport, {
          comment_id: "comment-conflicting-root",
        }).comments,
      ],
    };
    const harness = rendererHarness([conflicting]);

    const result = await harness.render(requestFor(report));

    expect(result).toMatchObject({ status: "needs_input" });
    expect(result).toHaveProperty(
      "reason",
      expect.stringContaining("exactly one root"),
    );
    expect(harness.publishSharedContext).not.toHaveBeenCalled();
  });

  it("returns a precise request while preserving the active session and creating no snapshot", async () => {
    const report = await humanInputReport();
    const issue = managedIssue(report);
    const harness = rendererHarness([issue, issue]);

    const result = await harness.render(requestFor(report));

    expect(result).toMatchObject({
      status: "needs_input",
      human_input_request: {
        diagnostic_session: {
          identity: report.diagnostic_session?.worktree.identity,
          lifecycle: "active",
        },
      },
    });
    expect(report.diagnostic_session?.diagnostic_branch).toBeUndefined();
    expect(report.diagnostic_session?.codex_thread_id).toBe(
      "thread-contract-54",
    );
    expect(harness.publishSharedContext).not.toHaveBeenCalled();
  });
});
