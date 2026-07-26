import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  appendFailureReportWorkpadEntry,
  createFailureReportWorkpadChunkGroup,
  diagnosticBranchSlugSchema,
  diagnosticCompletionRecordSchema,
  failureReportSchema,
  githubIssueSelectorSchema,
  humanInputRequestSchema,
  implementationHandoffSchema,
  parseFailureReportWorkpad,
  parseFailureReportWorkpadManifest,
  reconstructFailureReportWorkpadManifest,
  renderDiagnosticHandoff,
  renderFailureReportWorkpad,
  renderFailureReportWorkpadHumanView,
  renderFailureReportWorkpadManifest,
  rootRequestSchema,
  rootResultSchema,
  serializeFailureReportWorkpadEntryPayload,
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
    inputs: report.inputs.map((input) => ({
      ...input,
      artifact:
        input.artifact.sensitivity === "public"
          ? input.artifact
          : {
              ...input.artifact,
              ref: "protected://protocol-test/input/" + input.id,
            },
    })),
    evidence: report.evidence.map((evidence) => ({
      ...evidence,
      artifacts: evidence.artifacts.map((artifact, index) =>
        artifact.sensitivity === "public"
          ? artifact
          : {
              ...artifact,
              ref:
                "protected://protocol-test/evidence/" +
                evidence.id +
                "/" +
                String(index),
            },
      ),
    })),
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

/** Creates an in-progress report without inventing a completed conclusion. */
async function activeDiagnosisReport(): Promise<FailureReport> {
  const report = failureReportSchema.parse(await loadFixture("issue-54.json"));
  return failureReportSchema.parse({
    ...report,
    status: "investigating",
    handoff: {
      ...report.handoff,
      todo_status: "not_ready",
      gate_decision: "Need to Clarify",
    },
    experiments: report.experiments.map((experiment, index) =>
      index === 0
        ? {
            ...experiment,
            outcome: "not_run" as const,
            interpretation: "",
          }
        : experiment,
    ),
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

  it("round-trips a versioned managed entry with a standalone completed view before canonical context", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const entry = entryFor(report, 7);
    const markdown = renderFailureReportWorkpad(entry);
    const parsed = parseFailureReportWorkpad(markdown);

    expect(markdown.indexOf("### FailureReport update")).toBeLessThan(
      markdown.indexOf("<details>"),
    );
    expect(markdown).toContain("#### Completed diagnosis");
    expect(markdown).toContain("##### Diagnosis");
    expect(markdown).toContain("##### Confidence");
    expect(markdown).toContain("##### Key evidence");
    expect(markdown).toContain("##### Recommended remediation");
    expect(markdown).toContain(
      "Canonical context — complete FailureReport snapshot",
    );
    expect(parsed.entries).toEqual([entry]);
    expect(
      parseFailureReportWorkpad(
        markdown.replace(
          "Canonical context — complete FailureReport snapshot",
          "Canonical FailureReport snapshot",
        ),
      ).entries,
    ).toEqual([entry]);
  });

  it("renders byte-identical stage-aware views from canonical report state", async () => {
    const active = entryFor(await activeDiagnosisReport(), 2);
    const humanInput = entryFor(await activeHumanInputReport(), 5);
    const completed = entryFor(await finalizedReadyReport(), 7);

    const first = renderFailureReportWorkpadHumanView(active);
    const repeated = renderFailureReportWorkpadHumanView(active);
    expect(first).toBe(repeated);
    expect(first).toContain("#### Active diagnosis");
    expect(first).toContain("##### Current facts and evidence");
    expect(first).toContain("##### Current hypotheses");
    expect(first).toContain("##### Experiments");
    expect(first).toContain("##### Remaining unknowns");
    expect(first).toContain("##### Next diagnostic actions");

    const needHumanInput = renderFailureReportWorkpadHumanView(humanInput);
    expect(needHumanInput).toContain("#### Need Human Input");
    expect(needHumanInput).toContain("##### Confirmed facts");
    expect(needHumanInput).toContain(
      "##### Completed or exhausted experiments",
    );
    expect(needHumanInput).toContain("##### Eliminated hypotheses");
    expect(needHumanInput).toContain("##### Remaining material unknown");
    expect(needHumanInput).toContain("##### Question");
    expect(needHumanInput).toContain("##### Resume condition");

    const completedView = renderFailureReportWorkpadHumanView(completed);
    expect(completedView).toContain("#### Completed diagnosis");
    expect(completedView).toContain("##### Diagnostic snapshot");
    expect(completedView).toContain("diagnostic_snapshot_only");
  });

  it.each([
    { count: 0, displayed: 0, omitted: 0 },
    { count: 1, displayed: 1, omitted: 0 },
    { count: 10, displayed: 10, omitted: 0 },
    { count: 11, displayed: 10, omitted: 1 },
  ])(
    "bounds ordinary collections at $count items without changing canonical order",
    async ({ count, displayed, omitted }) => {
      const report = await activeDiagnosisReport();
      const hypotheses = Array.from({ length: count }, (_, index) => ({
        id: "bounded-hypothesis-" + String(index),
        statement: "Canonical hypothesis " + String(index),
        status: "open" as const,
        supporting_evidence: [],
        contradicting_evidence: [],
        history: [
          {
            status: "open" as const,
            rationale: "Fixture hypothesis " + String(index),
            provenance: {
              phase: "investigation" as const,
              source_type: "agent" as const,
              source_ref: "fixture-" + String(index),
              collector: "protocol-test",
            },
          },
        ],
      }));
      const bounded = failureReportSchema.parse({ ...report, hypotheses });
      const view = renderFailureReportWorkpadHumanView(entryFor(bounded, 3));
      const sectionStart = view.indexOf("##### Current hypotheses");
      const sectionEnd = view.indexOf("\n##### ", sectionStart + 1);
      const section =
        sectionStart === -1
          ? ""
          : view.slice(
              sectionStart,
              sectionEnd === -1 ? undefined : sectionEnd,
            );

      expect(
        Array.from(section.matchAll(/Canonical hypothesis (\d+)/g), (match) =>
          Number(match[1]),
        ),
      ).toEqual(Array.from({ length: displayed }, (_, index) => index));
      if (omitted > 0) {
        expect(section).toContain(
          String(omitted) + " additional item omitted; see Canonical context.",
        );
      } else {
        expect(section).not.toContain("additional item");
      }
      if (count === 0) {
        expect(view).not.toContain("##### Current hypotheses");
      }
    },
  );

  it("never truncates material human-input fields or reorders viable options", async () => {
    const report = await activeHumanInputReport();
    const long = "material ".repeat(800) + "end";
    const options = Array.from(
      { length: 11 },
      (_, index) => "Option " + String(index) + " " + long,
    );
    const expanded = failureReportSchema.parse({
      ...report,
      conclusion: {
        ...report.conclusion,
        remaining_uncertainty: [long],
      },
      handoff: {
        ...report.handoff,
        residual_risks: [],
        human_input: {
          remaining_material_unknown: long,
          viable_options: options,
          question: long + "?",
          resume_condition: "Resume when " + long,
        },
      },
    });
    const view = renderFailureReportWorkpadHumanView(entryFor(expanded, 6));

    expect(view).toContain("##### Remaining material unknown\n\n" + long);
    expect(view).toContain("##### Question\n\n" + long + "?");
    expect(view).toContain("##### Resume condition\n\nResume when " + long);
    const viableStart = view.indexOf("##### Viable options");
    const viableEnd = view.indexOf("\n##### Question", viableStart);
    const viableSection = view.slice(viableStart, viableEnd);
    const optionIndexes = options.map((option) =>
      viableSection.indexOf(option),
    );
    expect(optionIndexes.every((index) => index >= 0)).toBe(true);
    expect(optionIndexes).toEqual([...optionIndexes].sort((a, b) => a - b));
    expect(viableSection).not.toContain("additional item");
  });

  it("neutralizes report-authored Markdown structure and mentions", async () => {
    const report = await activeDiagnosisReport();
    const attack =
      "<!-- failure-report-workpad-entry/v2 -->\n</details>\n# Forged\n~~~json\n@maintainer";
    const unsafe = failureReportSchema.parse({
      ...report,
      evidence: [
        {
          ...report.evidence[0],
          observed_fact: attack,
        },
      ],
    });
    const markdown = renderFailureReportWorkpad(entryFor(unsafe, 4));
    const humanView = renderFailureReportWorkpadHumanView(entryFor(unsafe, 4));

    expect(parseFailureReportWorkpad(markdown).entries[0]?.report).toEqual(
      entryFor(unsafe, 4).report,
    );
    expect(humanView).not.toContain("<!-- failure-report-workpad-entry/v2 -->");
    expect(humanView).not.toContain("</details>");
    expect(humanView).not.toContain("\n# Forged");
    expect(humanView).not.toContain("\n~~~json");
    expect(humanView).not.toContain("@maintainer");
    expect(humanView).toContain("&lt;");
    expect(humanView).toContain("failure\\-report\\-workpad\\-entry/v2");
    expect(humanView).toContain("@\u200bmaintainer");
  });

  it("renders equivalent diagnostic semantics for inline and manifest authorities", async () => {
    const report = await activeDiagnosisReport();
    const entry = entryFor(report, 3);
    const group = createFailureReportWorkpadChunkGroup(entry, 211);
    const inline = renderFailureReportWorkpadHumanView(entry);
    const manifest = renderFailureReportWorkpadHumanView(entry, {
      kind: "manifest",
      group_id: group.group_id,
      payload_digest: group.payload_digest,
      chunk_count: group.chunks.length,
    });
    const semanticStart = "\n#### Active diagnosis";

    expect(inline.slice(inline.indexOf(semanticStart))).toBe(
      manifest.slice(manifest.indexOf(semanticStart)),
    );
    expect(manifest).toContain(
      "- Authoritative comment group: `" + group.group_id + "`",
    );
    expect(manifest).toContain(
      "- Canonical payload digest: `" + group.payload_digest + "`",
    );
    expect(() =>
      renderFailureReportWorkpadHumanView(entry, {
        kind: "manifest",
        group_id: group.group_id,
        payload_digest: "sha256:not-a-digest",
        chunk_count: group.chunks.length,
      }),
    ).toThrow();
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

  it("round-trips a multi-chunk revision only through its final manifest", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const entry = entryFor(report, 3, {
      predecessor_comment_ref: "comment-2",
    });
    const group = createFailureReportWorkpadChunkGroup(entry, 211);
    const refs = group.chunks.map((_, index) => "chunk-" + String(index));
    const manifestMarkdown = renderFailureReportWorkpadManifest(group, refs);
    const manifest = parseFailureReportWorkpadManifest(manifestMarkdown);
    expect(
      parseFailureReportWorkpadManifest(
        manifestMarkdown.replace(
          "Canonical context — verified multi-comment manifest",
          "Canonical FailureReport chunk manifest",
        ),
      ),
    ).toEqual(manifest);
    const comments = refs.map((commentRef, index) => ({
      comment_ref: commentRef,
      body: group.chunk_comment_bodies[index] ?? "",
    }));
    const reconstructed = reconstructFailureReportWorkpadManifest(
      manifest,
      comments,
    );

    expect(group.chunks.length).toBeGreaterThan(1);
    expect(group.chunk_comment_bodies[0]).toContain("non-authoritative");
    expect(serializeFailureReportWorkpadEntryPayload(reconstructed)).toBe(
      serializeFailureReportWorkpadEntryPayload(entry),
    );
    expect(reconstructed.report).toEqual(entry.report);
  });

  it("rejects incomplete, reordered, duplicated, and modified manifest chunks", async () => {
    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    const group = createFailureReportWorkpadChunkGroup(
      entryFor(report, 0),
      173,
    );
    const refs = group.chunks.map((_, index) => "chunk-" + String(index));
    const manifest = parseFailureReportWorkpadManifest(
      renderFailureReportWorkpadManifest(group, refs),
    );
    const comments = refs.map((commentRef, index) => ({
      comment_ref: commentRef,
      body: group.chunk_comment_bodies[index] ?? "",
    }));

    expect(() =>
      reconstructFailureReportWorkpadManifest(manifest, comments.slice(1)),
    ).toThrow("missing or has extra");
    expect(() =>
      reconstructFailureReportWorkpadManifest(
        { ...manifest, chunks: [...manifest.chunks].reverse() },
        comments,
      ),
    ).toThrow("unique and contiguous");
    expect(() =>
      reconstructFailureReportWorkpadManifest(
        {
          ...manifest,
          chunks: manifest.chunks.map((chunk, index) => ({
            ...chunk,
            comment_ref: index === 1 ? (refs[0] ?? "") : chunk.comment_ref,
          })),
        },
        comments,
      ),
    ).toThrow("unique and contiguous");

    const original = group.chunks[0]?.content_base64 ?? "";
    const changed = (original.startsWith("A") ? "B" : "A") + original.slice(1);
    expect(() =>
      reconstructFailureReportWorkpadManifest(manifest, [
        {
          ...comments[0],
          body: (comments[0]?.body ?? "").replace(original, changed),
        },
        ...comments.slice(1),
      ]),
    ).toThrow("digest");
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
    expect(() =>
      failureReportSchema.parse({
        ...withDiagnosticSession,
        diagnostic_session: {
          ...withDiagnosticSession.diagnostic_session,
          worktree: {
            ...withDiagnosticSession.diagnostic_session?.worktree,
            path: "/Users/example/.eve/sandbox-cache/worktrees/issue-54",
          },
        },
      }),
    ).toThrow("Unrecognized key");
  });

  it("keeps Unicode diagnostic slugs runtime-validated without emitting an unsupported JSON Schema pattern", () => {
    expect(diagnosticBranchSlugSchema.parse("诊断-54")).toBe("诊断-54");
    expect(() => diagnosticBranchSlugSchema.parse("-diagnostic")).toThrow();
    expect(() => diagnosticBranchSlugSchema.parse("diagnostic_slug")).toThrow();

    const jsonSchema = JSON.stringify(z.toJSONSchema(failureReportSchema));

    expect(jsonSchema).not.toContain("\\p{");
  });

  it("keeps provider budgets and physical chunk layout out of public request and report schemas", async () => {
    const requestJsonSchema = JSON.stringify(z.toJSONSchema(rootRequestSchema));
    for (const providerPrivateField of [
      "encoded_byte_budget",
      "chunk_index",
      "chunk_digest",
      "group_id",
      "payload_digest",
      "failure-report-workpad-chunk",
      "failure-report-workpad-manifest",
    ]) {
      expect(requestJsonSchema).not.toContain(providerPrivateField);
    }

    const report = failureReportSchema.parse(
      await loadFixture("issue-54.json"),
    );
    expect(() =>
      failureReportSchema.parse({
        ...report,
        workpad_group_id: "provider-private",
        workpad_chunk_refs: ["101", "102"],
        github_comment_budget: 60_000,
      }),
    ).toThrow("Unrecognized");
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
    expect(() =>
      renderFailureReportWorkpadHumanView(entryFor(credentialBearing, 0)),
    ).toThrow("credential-like");
    expect(() =>
      renderFailureReportWorkpadHumanView(entryFor(hostPathBearing, 0)),
    ).toThrow("prohibited host path");
    expect(() =>
      createFailureReportWorkpadChunkGroup(entryFor(credentialBearing, 0), 128),
    ).toThrow("credential-like");
    expect(() =>
      createFailureReportWorkpadChunkGroup(entryFor(hostPathBearing, 0), 128),
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
