import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  appendFailureReportWorkpadEntry,
  diagnosticBranchSlugSchema,
  diagnosticCompletionRecordSchema,
  failureReportSchema,
  githubIssueSelectorSchema,
  humanInputRequestSchema,
  implementationHandoffSchema,
  parseFailureReportWorkpad,
  renderDiagnosticHandoff,
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

/** Creates a complete finalized report suitable for deterministic handoff tests. */
async function finalizedReadyReport(revision = 7): Promise<FailureReport> {
  const report = failureReportSchema.parse(
    await loadFixture("contract-recipe-identifier.json"),
  );
  const logicalSessionId = "github-issue/Alive24/CKBoost/54/" + report.id;
  const entryId = logicalSessionId + "/revision-" + String(revision);
  const sessionIdentity = "diagnostic-54-contract-recipe";
  return failureReportSchema.parse({
    ...report,
    shared_context: {
      provider: "github_issue",
      repository: "Alive24/CKBoost",
      issue_number: 54,
      issue_url: "https://github.com/Alive24/CKBoost/issues/54",
      workpad_marker: workpadMarker,
      workpad_comment_ref: "comment-ready-54",
      workpad_revision: revision,
      workpad_logical_session_id: logicalSessionId,
      workpad_entry_id: entryId,
      workpad_producer_id: "root-gh",
      synced_at: report.updated_at,
    },
    diagnostic_session: {
      lifecycle: "finalized",
      domain_extensions: ["ckb"],
      backend_id: "codex_app_server",
      codex_thread_id: "thread-ready-54",
      worktree: {
        path: "/root-owned/worktrees/diagnostic-54",
        identity: sessionIdentity,
        base_revision: report.target.revision,
        head_revision: report.target.revision,
      },
      diagnostic_branch_slug: "contract-recipe-identifier",
      diagnostic_branch: {
        name: "diagnostic/54-contract-recipe-identifier",
        head_revision: report.target.revision,
        remote_name: "origin",
        remote_ref: "refs/heads/diagnostic/54-contract-recipe-identifier",
        remote_url:
          "https://github.com/Alive24/CKBoost/tree/diagnostic/54-contract-recipe-identifier",
        pushed_at: report.updated_at,
        finalized_at: report.updated_at,
        reuse_policy: "diagnostic_snapshot_only",
      },
    },
    diagnostic_completions: [
      {
        schema_version: "failure-report/diagnostic-completion/v1",
        completion_id: "diagnostic-completion/contract-recipe",
        report_id: report.id,
        target_revision: report.target.revision,
        diagnostic_session_identity: sessionIdentity,
        codex_thread_id: "thread-ready-54",
        observed_worktree_head: report.target.revision,
        outcome: {
          evidence: [],
          operation_evidence: [],
          hypotheses: [],
          experiments: [],
        },
        metadata: {
          completed_at: report.updated_at,
          owner: "root",
          provider: "codex_app_server",
        },
      },
    ],
  });
}

/** Creates an unresolved report that must preserve and resume its active session. */
async function activeHumanInputReport(): Promise<FailureReport> {
  const report = failureReportSchema.parse(await loadFixture("issue-54.json"));
  const revision = 5;
  const logicalSessionId = "github-issue/Alive24/CKBoost/54/" + report.id;
  return failureReportSchema.parse({
    ...report,
    status: "needs_input",
    conclusion: {
      ...report.conclusion,
      remaining_uncertainty: [
        "The required submission durability quorum is a product policy decision.",
      ],
    },
    shared_context: {
      provider: "github_issue",
      repository: "Alive24/CKBoost",
      issue_number: 54,
      issue_url: "https://github.com/Alive24/CKBoost/issues/54",
      workpad_marker: workpadMarker,
      workpad_comment_ref: "comment-human-input-54",
      workpad_revision: revision,
      workpad_logical_session_id: logicalSessionId,
      workpad_entry_id: logicalSessionId + "/revision-" + String(revision),
      workpad_producer_id: "root-gh",
      synced_at: report.updated_at,
    },
    diagnostic_session: {
      lifecycle: "active",
      domain_extensions: ["ckb"],
      backend_id: "codex_app_server",
      codex_thread_id: "thread-human-input-54",
      worktree: {
        path: "/root-owned/worktrees/diagnostic-human-input-54",
        identity: "diagnostic-human-input-54",
        base_revision: report.target.revision,
        head_revision: report.target.revision,
      },
      diagnostic_branch_slug: "issue-54-human-input",
    },
    handoff: {
      ...report.handoff,
      todo_status: "not_ready",
      gate_decision: "Need to Clarify",
      residual_risks: [],
      human_input: {
        remaining_material_unknown:
          "The required submission durability quorum is a product policy decision.",
        viable_options: [
          "Require two independently verified relay copies.",
          "Require three independently verified relay copies.",
        ],
        question:
          "Which verified relay-copy quorum must gate submission finalization?",
        resume_condition:
          "Resume this same diagnostic session after the owner selects one quorum.",
      },
    },
  });
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
      expect(report.handoff.todo_status).toBe("ready");
    },
  );

  it("rejects the removed assumption-dependent states without aliases or migration", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );

    expect(() =>
      failureReportSchema.parse({
        ...report,
        handoff: {
          ...report.handoff,
          todo_status: "ready_with_assumptions",
        },
      }),
    ).toThrow();
    expect(() =>
      failureReportSchema.parse({
        ...report,
        handoff: {
          ...report.handoff,
          gate_decision: "Ready With Assumptions",
        },
      }),
    ).toThrow();
  });

  it("requires every Todo-ready uncertainty to be explicitly non-blocking", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("contract-recipe-identifier.json"),
    );

    expect(() =>
      failureReportSchema.parse({
        ...report,
        conclusion: {
          ...report.conclusion,
          remaining_uncertainty: [
            ...report.conclusion.remaining_uncertainty,
            "A material implementation choice is unresolved.",
          ],
        },
      }),
    ).toThrow("every remaining uncertainty must be classified");
  });

  it("requires a revision-bound persisted report for render_handoff requests", async () => {
    const report = await finalizedReadyReport();

    expect(
      rootRequestSchema.parse({
        request_id: "render-ready-report",
        operation: "render_handoff",
        report,
      }).report,
    ).toEqual(report);
    expect(() =>
      rootRequestSchema.parse({
        request_id: "render-without-report",
        operation: "render_handoff",
        issue_selector: {
          repository: "Alive24/CKBoost",
          issue_number: 54,
        },
      }),
    ).toThrow("persisted report binding");
  });

  it("renders byte-identical canonical implementation handoffs and revision-bound identities", async () => {
    const report = await finalizedReadyReport();
    const reordered = failureReportSchema.parse({
      ...report,
      evidence: [...report.evidence].reverse(),
      handoff: {
        ...report.handoff,
        scope_in: [...report.handoff.scope_in].reverse(),
        guardrails: [...report.handoff.guardrails].reverse(),
        verification: {
          ...report.handoff.verification,
          automated: [...report.handoff.verification.automated].reverse(),
        },
      },
    });
    const first = renderDiagnosticHandoff(report);
    const second = renderDiagnosticHandoff(reordered);
    const advanced = renderDiagnosticHandoff(await finalizedReadyReport(8));

    expect(first.schema_version).toBe(
      "failure-report/implementation-handoff/v1",
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.markdown).toBe(second.markdown);
    expect(first.markdown.endsWith("\n")).toBe(true);
    const firstId = "handoff_id" in first ? first.handoff_id : first.request_id;
    const advancedId =
      "handoff_id" in advanced ? advanced.handoff_id : advanced.request_id;
    expect(advancedId).not.toBe(firstId);
    expect(implementationHandoffSchema.parse(first)).toEqual(first);
    expect(() =>
      implementationHandoffSchema.parse({ ...first, downstream_lane: "main" }),
    ).toThrow();
  });

  it("renders one structured human-input request while retaining active-session identity", async () => {
    const report = await activeHumanInputReport();
    const rendered = renderDiagnosticHandoff(report);

    expect(rendered.schema_version).toBe(
      "failure-report/human-input-request/v1",
    );
    if (rendered.schema_version !== "failure-report/human-input-request/v1") {
      throw new Error("Expected a human-input request.");
    }
    expect(rendered.question.match(/\?/g)).toHaveLength(1);
    expect(rendered.diagnostic_session).toEqual({
      identity: report.diagnostic_session?.worktree.identity,
      lifecycle: "active",
    });
    expect(rendered.completed_or_exhausted_experiments.length).toBeGreaterThan(
      0,
    );
    expect(rendered.eliminated_hypotheses.length).toBeGreaterThan(0);
    expect(humanInputRequestSchema.parse(rendered)).toEqual(rendered);
    expect(() =>
      humanInputRequestSchema.parse({ ...rendered, tracker_status: "Todo" }),
    ).toThrow();
  });

  it("makes Root handoff outputs explicit and mutually exclusive", async () => {
    const implementation = renderDiagnosticHandoff(
      await finalizedReadyReport(),
    );
    const humanInput = renderDiagnosticHandoff(await activeHumanInputReport());

    expect(
      rootResultSchema.parse({
        request_id: "render-ready-54",
        status: "completed",
        summary: "Rendered the latest finalized handoff.",
        implementation_handoff: implementation,
      }).implementation_handoff,
    ).toEqual(implementation);
    expect(
      rootResultSchema.parse({
        request_id: "render-human-input-54",
        status: "needs_input",
        summary: "One material product decision remains.",
        human_input_request: humanInput,
      }).human_input_request,
    ).toEqual(humanInput);
    expect(() =>
      rootResultSchema.parse({
        request_id: "render-conflict-54",
        status: "completed",
        summary: "Conflicting outputs.",
        implementation_handoff: implementation,
        human_input_request: humanInput,
      }),
    ).toThrow("mutually exclusive");
    expect(() =>
      rootResultSchema.parse({
        request_id: "legacy-markdown-only",
        status: "completed",
        summary: "Legacy output.",
        handoff_markdown: "# Unstructured",
      }),
    ).toThrow();
  });

  it("persists a typed Root-owned diagnostic completion with session bindings", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const session = {
      lifecycle: "active" as const,
      domain_extensions: ["ckb"],
      backend_id: "codex_app_server",
      codex_thread_id: "thr-54",
      worktree: {
        path: "/root-owned-runtime/worktrees/diagnostic-54",
        identity: "diagnostic-54",
        base_revision: report.target.revision,
        head_revision: report.target.revision,
      },
      diagnostic_branch_slug: "ckboost-issue-54",
    };
    const completion = diagnosticCompletionRecordSchema.parse({
      schema_version: "failure-report/diagnostic-completion/v1",
      completion_id: "diagnostic-completion/example",
      report_id: report.id,
      target_revision: report.target.revision,
      diagnostic_session_identity: session.worktree.identity,
      codex_thread_id: session.codex_thread_id,
      observed_worktree_head: report.target.revision,
      outcome: {
        evidence: [],
        operation_evidence: [],
        hypotheses: [],
        experiments: [],
      },
      metadata: {
        completed_at: "2026-07-15T10:00:00Z",
        owner: "root",
        provider: "codex_app_server",
      },
    });

    const persisted = failureReportSchema.parse({
      ...report,
      diagnostic_session: session,
      diagnostic_completions: [completion],
    });
    expect(persisted.diagnostic_completions).toEqual([completion]);
    expect(() =>
      failureReportSchema.parse({
        ...persisted,
        diagnostic_completions: [
          { ...completion, codex_thread_id: "thr-other" },
        ],
      }),
    ).toThrow("persisted Codex thread");
  });

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
