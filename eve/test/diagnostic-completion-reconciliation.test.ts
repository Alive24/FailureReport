import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  failureReportSchema,
  parseFailureReportWorkpad,
  type FailureReport,
} from "@failure-report/protocol";

import {
  type DiagnosticCompletionInput,
  createDiagnosticCompletionIdentity,
} from "../agent/lib/diagnostics/completion.js";
import { diagnosticSessionEnvelopeSchema } from "../agent/lib/diagnostics/envelope.js";
import {
  DiagnosticSessionWorkpad,
  type DiagnosticSessionIssueGateway,
} from "../agent/lib/diagnostics/workpad.js";
import type { DiagnosticWorktreeManager } from "../agent/lib/diagnostics/worktree.js";
import {
  WorkpadPublicationRaceError,
  type PublishedSharedContext,
} from "../agent/lib/integrations/github/issue-gateway.js";
import {
  findExistingWorkpad,
  prepareIssueWorkpadMutation,
  type GithubIssueSnapshot,
  type WorkpadProducerConfiguration,
} from "../agent/lib/integrations/github/issue-workpad.js";

const producers: WorkpadProducerConfiguration = {
  current: { id: "root-gh", github_actor_id: "101" },
  producers: [{ id: "root-gh", github_actor_id: "101" }],
};

const targetRevision = "a".repeat(40);
const changedHead = "b".repeat(40);

/** Exercises the Root-only completion transaction without a live GitHub write. */
describe("diagnostic completion reconciliation", () => {
  it("creates one deterministic record and treats a restarted provider replay as a no-op", async () => {
    const harness = await createHarness();
    const input = completionInput("first");

    const first = await harness.workpad.reconcileCompletion(
      harness.envelope,
      input,
    );
    expect(first).toMatchObject({
      status: "completed",
      idempotent: false,
      attempts: 1,
      completion: {
        report_id: harness.report.id,
        target_revision: targetRevision,
        diagnostic_session_identity: "diagnostic-54",
        codex_thread_id: "thr-54",
        observed_worktree_head: changedHead,
      },
    });
    if (first.status !== "completed") {
      throw new Error("Expected a durable completion.");
    }
    expect(first.completion.completion_id).toBe(
      createDiagnosticCompletionIdentity({
        report_id: harness.report.id,
        target_revision: targetRevision,
        diagnostic_session_identity: "diagnostic-54",
        codex_thread_id: "thr-54",
        observed_worktree_head: changedHead,
      }),
    );
    expect(first.report.diagnostic_completions).toEqual([first.completion]);
    expect(first.report.evidence.map((evidence) => evidence.id)).toContain(
      "completion-evidence-first",
    );
    expect(first.report.diagnostic_session?.worktree.head_revision).toBe(
      changedHead,
    );
    expect(harness.gateway.entryCount()).toBe(2);
    expect(harness.gateway.issue.body).toBe("# Human-owned Issue body");
    expect(harness.gateway.foreignCommentBody()).toBe(
      "Human context stays put.",
    );

    // A fresh workpad instance models process restart after the provider has
    // replayed its finish event. It sees the durable record before publishing.
    const restarted = new DiagnosticSessionWorkpad({
      worktrees: harness.worktrees,
      gateway: harness.gateway,
      now: () => "2026-07-15T10:10:00Z",
    });
    const replay = await restarted.reconcileCompletion(harness.envelope, input);
    expect(replay).toMatchObject({
      status: "completed",
      idempotent: true,
      attempts: 1,
      workpad_revision: first.workpad_revision,
    });
    expect(harness.gateway.publishCalls).toBe(1);
    expect(harness.gateway.entryCount()).toBe(2);
  });

  it("rejects a divergent duplicate identity instead of appending replacement evidence", async () => {
    const harness = await createHarness();
    await harness.workpad.reconcileCompletion(
      harness.envelope,
      completionInput("first"),
    );

    const duplicate = await harness.workpad.reconcileCompletion(
      harness.envelope,
      completionInput("first", "A materially different worker outcome."),
    );
    expect(duplicate).toMatchObject({
      status: "needs_input",
      reason: expect.stringContaining("incompatible content"),
    });
    expect(harness.gateway.entryCount()).toBe(2);
    expect(harness.gateway.publishCalls).toBe(1);
  });

  it("projects only Root-owned evidence, hypotheses, conclusion, and operation fields", async () => {
    const harness = await createHarness();
    const result = await harness.workpad.reconcileCompletion(
      harness.envelope,
      detailedCompletionInput(),
    );

    expect(result).toMatchObject({
      status: "completed",
      report: {
        status: "diagnosed",
        conclusion: {
          diagnosis: "The bounded diagnostic has a durable conclusion.",
        },
      },
    });
    if (result.status !== "completed") {
      throw new Error("Expected a completed detailed outcome.");
    }
    expect(result.report.evidence.map((evidence) => evidence.id)).toEqual(
      expect.arrayContaining([
        "completion-evidence-detailed",
        "completion-operation-detailed",
      ]),
    );
    expect(
      result.report.hypotheses.map((hypothesis) => hypothesis.id),
    ).toContain("completion-hypothesis-detailed");
    expect(
      result.report.experiments.map((experiment) => experiment.id),
    ).toContain("completion-experiment-detailed");

    // The App Server can replay a bare finish without re-emitting Root's
    // previously validated report outcome. The durable record remains the
    // authority, so this is a no-op rather than a conflicting replacement.
    const bareReplay = await harness.workpad.reconcileCompletion(
      harness.envelope,
      { codex_thread_id: "thr-54" },
    );
    expect(bareReplay).toMatchObject({
      status: "completed",
      idempotent: true,
    });
    expect(harness.gateway.publishCalls).toBe(1);
  });

  it("returns needs_input for mismatched report, thread, and newer persisted HEAD bindings", async () => {
    const harness = await createHarness();
    const wrongReport = await harness.workpad.reconcileCompletion(
      { ...harness.envelope, report_id: "another-report" },
      completionInput("first"),
    );
    expect(wrongReport).toMatchObject({
      status: "needs_input",
      reason: expect.stringContaining("report id"),
    });

    const wrongThread = await harness.workpad.reconcileCompletion(
      harness.envelope,
      { ...completionInput("first"), codex_thread_id: "thr-other" },
    );
    expect(wrongThread).toMatchObject({
      status: "needs_input",
      reason: expect.stringContaining("thread"),
    });

    const newerHead = await createHarness({
      initial_last_diagnosed_at: "2026-07-15T10:00:02Z",
    });
    const staleHead = await newerHead.workpad.reconcileCompletion(
      newerHead.envelope,
      completionInput("first"),
    );
    expect(staleHead).toMatchObject({
      status: "needs_input",
      reason: expect.stringContaining("newer diagnostic completion"),
    });
    expect(newerHead.gateway.publishCalls).toBe(0);
  });

  it("retries a verified stale revision and preserves concurrent Root state", async () => {
    const harness = await createHarness({ concurrent_races: 1 });

    const result = await harness.workpad.reconcileCompletion(
      harness.envelope,
      completionInput("first"),
    );
    expect(result).toMatchObject({
      status: "completed",
      idempotent: false,
      attempts: 2,
    });
    if (result.status !== "completed") {
      throw new Error("Expected a completed retry.");
    }
    expect(result.report.evidence.map((evidence) => evidence.id)).toEqual(
      expect.arrayContaining([
        "completion-evidence-concurrent",
        "completion-evidence-first",
      ]),
    );
    expect(harness.gateway.publishCalls).toBe(2);
    expect(harness.gateway.issue.body).toBe("# Human-owned Issue body");
    expect(harness.gateway.foreignCommentBody()).toBe(
      "Human context stays put.",
    );
  });

  it("stops after its bounded race budget and reports post-write readback failures", async () => {
    const exhausted = await createHarness({ concurrent_races: 3 });
    const exhaustedWorkpad = new DiagnosticSessionWorkpad({
      worktrees: exhausted.worktrees,
      gateway: exhausted.gateway,
      now: () => "2026-07-15T10:10:00Z",
      completion_retry_limit: 1,
    });
    const exhaustedResult = await exhaustedWorkpad.reconcileCompletion(
      exhausted.envelope,
      completionInput("first"),
    );
    expect(exhaustedResult).toMatchObject({
      status: "needs_input",
      attempts: 2,
      reason: expect.stringContaining("exhausted"),
    });
    expect(exhausted.gateway.publishCalls).toBe(2);

    const readbackFailure = await createHarness({
      post_write_readback: "missing_record",
    });
    const readbackResult = await readbackFailure.workpad.reconcileCompletion(
      readbackFailure.envelope,
      completionInput("first"),
    );
    expect(readbackResult).toMatchObject({
      status: "needs_input",
      reason: expect.stringContaining("post-write readback"),
    });
  });
});

type HarnessOptions = {
  concurrent_races?: number;
  initial_last_diagnosed_at?: string;
  post_write_readback?: "missing_record";
};

type Harness = {
  envelope: ReturnType<typeof diagnosticSessionEnvelopeSchema.parse>;
  gateway: MutableIssueGateway;
  report: FailureReport;
  workpad: DiagnosticSessionWorkpad;
  worktrees: DiagnosticWorktreeManager;
};

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../packages/protocol/test/fixtures/issue-54.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;
  const report = failureReportSchema.parse({
    ...(fixture as Record<string, unknown>),
    status: "investigating",
    target: {
      ...(fixture as { target: Record<string, unknown> }).target,
      revision: targetRevision,
    },
    diagnostic_session: {
      lifecycle: "active",
      domain_extensions: ["ckb"],
      backend_id: "codex_app_server",
      codex_thread_id: "thr-54",
      worktree: {
        path: "/root/.eve/sandbox-cache/worktrees/diagnostic-54",
        identity: "diagnostic-54",
        base_revision: targetRevision,
        head_revision: targetRevision,
      },
      diagnostic_branch_slug: "ckboost-issue-54",
      ...(options.initial_last_diagnosed_at
        ? { last_diagnosed_at: options.initial_last_diagnosed_at }
        : {}),
    },
  });
  const gateway = new MutableIssueGateway(report, options);
  const worktrees = {
    async captureCurrent(
      _report: FailureReport,
      state: NonNullable<FailureReport["diagnostic_session"]>,
    ) {
      return {
        canonical_path: "/canonical/CKBoost",
        state: {
          ...state,
          worktree: { ...state.worktree, head_revision: changedHead },
        },
      };
    },
  } as unknown as DiagnosticWorktreeManager;
  let second = 10;
  const workpad = new DiagnosticSessionWorkpad({
    worktrees,
    gateway,
    now: () => "2026-07-15T10:00:" + String(second++).padStart(2, "0") + "Z",
  });
  return {
    report,
    gateway,
    worktrees,
    workpad,
    envelope: diagnosticSessionEnvelopeSchema.parse({
      schema_version: "failure-report/diagnostic-session/v1",
      domain_extensions: ["ckb"],
      report_id: report.id,
      repository: "Alive24/CKBoost",
      issue_number: 54,
      workpad_revision: 0,
      request: "Inspect the first failing boundary.",
      native_skill_names: ["failure-report-ckb-debugging"],
    }),
  };
}

function completionInput(
  suffix: string,
  observation = "The Root-observed diagnostic evidence is durable.",
): DiagnosticCompletionInput {
  return {
    codex_thread_id: "thr-54",
    outcome: {
      evidence: [
        {
          id: "completion-evidence-" + suffix,
          kind: "tool_observation",
          observed_fact: observation,
          epistemic_status: "observed",
          provenance: {
            phase: "investigation",
            source_type: "agent",
            source_ref: "codex-thread/thr-54",
            collector: "failure-report-root",
            collected_at: "2026-07-15T10:00:03Z",
          },
          artifacts: [],
        },
      ],
    },
  };
}

function detailedCompletionInput(): DiagnosticCompletionInput {
  const provenance = {
    phase: "investigation" as const,
    source_type: "agent" as const,
    source_ref: "codex-thread/thr-54",
    collector: "failure-report-root",
    collected_at: "2026-07-15T10:00:03Z",
  };
  return {
    codex_thread_id: "thr-54",
    provider_finish_reason: "stop",
    outcome: {
      report_status: "diagnosed",
      evidence: [
        {
          id: "completion-evidence-detailed",
          kind: "repository_fact",
          observed_fact: "The diagnostic evidence was validated by Root.",
          epistemic_status: "verified",
          provenance,
          artifacts: [],
        },
      ],
      operation_evidence: [
        {
          id: "completion-operation-detailed",
          kind: "tool_observation",
          observed_fact: "The focused diagnostic command completed.",
          epistemic_status: "observed",
          provenance,
          artifacts: [],
        },
      ],
      hypotheses: [
        {
          id: "completion-hypothesis-detailed",
          statement: "The observed failure has the reported diagnostic cause.",
          status: "supported",
          supporting_evidence: ["completion-evidence-detailed"],
          contradicting_evidence: [],
          history: [
            {
              status: "supported",
              rationale:
                "The Root-validated evidence supports this hypothesis.",
              provenance,
            },
          ],
        },
      ],
      experiments: [
        {
          id: "completion-experiment-detailed",
          question: "Did the bounded diagnostic command complete?",
          proposed_action: "Run the focused diagnostic command.",
          approval: { required: false, status: "not_required" },
          baseline_evidence: [],
          result_evidence: ["completion-operation-detailed"],
          outcome: "confirmed",
          interpretation: "The operation evidence was recorded in the report.",
        },
      ],
      conclusion: {
        diagnosis: "The bounded diagnostic has a durable conclusion.",
        confidence: {
          level: "high",
          basis: "Root validated the completion outcome and worktree binding.",
        },
        remaining_uncertainty: ["No further uncertainty was reported."],
        recommended_remediation: ["Use the Root-owned handoff for follow-up."],
      },
    },
  };
}

class MutableIssueGateway implements DiagnosticSessionIssueGateway {
  readonly issue: GithubIssueSnapshot;
  publishCalls = 0;
  private concurrentRaces: number;
  private readonly postWriteReadback?: "missing_record";
  private nextSecond = 1;

  constructor(report: FailureReport, options: HarnessOptions) {
    this.concurrentRaces = options.concurrent_races ?? 0;
    this.postWriteReadback = options.post_write_readback;
    const initialIssue: GithubIssueSnapshot = {
      repository: "Alive24/CKBoost",
      issue_number: 54,
      title: "CKBoost Issue 54",
      issue_url: "https://github.com/Alive24/CKBoost/issues/54",
      body: "# Human-owned Issue body",
      updated_at: "2026-07-15T10:00:00Z",
      comments: [
        {
          id: "foreign-comment",
          body: "Human context stays put.",
          updated_at: "2026-07-15T10:00:00Z",
          author: { id: "999" },
        },
      ],
    };
    const initial = prepareIssueWorkpadMutation(
      initialIssue,
      report,
      this.timestamp(),
      producers,
    );
    this.issue = {
      ...initialIssue,
      updated_at: initial.report.updated_at,
      comments: [
        ...initialIssue.comments,
        {
          id: "root-comment",
          body: initial.workpad_comment_body,
          updated_at: initial.report.updated_at,
          author: { id: "101" },
        },
      ],
    };
  }

  getWorkpadProducerConfiguration(): WorkpadProducerConfiguration {
    return producers;
  }

  async readIssue(): Promise<GithubIssueSnapshot> {
    return this.issue;
  }

  async publishSharedContext(
    _repository: string,
    _issueNumber: number,
    report: FailureReport,
    syncedAt: string,
  ): Promise<PublishedSharedContext> {
    this.publishCalls += 1;
    if (this.concurrentRaces > 0) {
      this.concurrentRaces -= 1;
      this.appendConcurrentRootEvidence();
      throw new WorkpadPublicationRaceError(
        "FailureReport workpad changed while preparing the update.",
      );
    }
    const before = this.currentReport();
    const published = this.append(report, syncedAt);
    if (this.postWriteReadback === "missing_record") {
      return {
        ...published,
        report: before,
        workpad_revision: before.shared_context?.workpad_revision ?? 0,
      };
    }
    return published;
  }

  entryCount(): number {
    const root = this.issue.comments.find(
      (comment) => comment.id === "root-comment",
    );
    return parseFailureReportWorkpad(root?.body ?? "").entries.length;
  }

  foreignCommentBody(): string | undefined {
    return this.issue.comments.find(
      (comment) => comment.id === "foreign-comment",
    )?.body;
  }

  private appendConcurrentRootEvidence(): void {
    const report = this.currentReport();
    const concurrentEvidence = completionInput(
      "concurrent",
      "Concurrent Root evidence.",
    ).outcome?.evidence?.[0];
    if (!concurrentEvidence) {
      throw new Error("Missing concurrent Root evidence fixture.");
    }
    const concurrent = failureReportSchema.parse({
      ...report,
      evidence: [...report.evidence, concurrentEvidence],
    });
    this.append(concurrent, this.timestamp());
  }

  private append(
    report: FailureReport,
    syncedAt: string,
  ): PublishedSharedContext {
    const mutation = prepareIssueWorkpadMutation(
      this.issue,
      report,
      syncedAt,
      producers,
    );
    const commentRef = mutation.target_comment_ref ?? "root-comment";
    this.issue.updated_at = syncedAt;
    this.issue.comments = this.issue.comments.map((comment) =>
      comment.id === commentRef
        ? {
            ...comment,
            body: mutation.workpad_comment_body,
            updated_at: syncedAt,
          }
        : comment,
    );
    return {
      issue: this.issue,
      report: mutation.report,
      workpad_comment_ref: commentRef,
      workpad_revision: mutation.report.shared_context?.workpad_revision ?? 0,
    };
  }

  private currentReport(): FailureReport {
    const workpad = findExistingWorkpad(this.issue, producers);
    if (!workpad) {
      throw new Error("Missing test workpad.");
    }
    return workpad.report;
  }

  private timestamp(): string {
    return (
      "2026-07-15T10:00:" + String(this.nextSecond++).padStart(2, "0") + "Z"
    );
  }
}
