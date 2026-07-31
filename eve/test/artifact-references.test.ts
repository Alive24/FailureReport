import { readFile } from "node:fs/promises";

import {
  failureReportSchema,
  type DiagnosticCompletionOutcome,
  type DiagnosticSession,
} from "@failure-report/protocol";
import { describe, expect, it } from "vitest";

import {
  normalizeDiagnosticCompletionArtifactReferences,
  normalizeFailureReportArtifactReferences,
} from "../agent/lib/diagnostics/artifact-references.js";
import { createDiagnosticCompletionRecord } from "../agent/lib/diagnostics/completion.js";

async function loadReport() {
  const file = new URL(
    "../../packages/protocol/test/fixtures/issue-54.json",
    import.meta.url,
  );
  return failureReportSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

describe("Root artifact-reference normalization", () => {
  it("replaces every private location with a deterministic logical handle", async () => {
    const report = await loadReport();
    const privateRefs = [
      "/Users/alice/diagnostics/mac.log",
      "/home/alice/diagnostics/linux.log",
      "C:\\Users\\alice\\diagnostics\\windows.log",
      "file:///Users/alice/diagnostics/file-uri.log",
      "diagnostics/private-relative.log",
      "https://diagnostics.example.test/log?attempt=1",
    ];
    const privateEvidence = privateRefs.map((ref, index) => ({
      ...report.evidence[0]!,
      id: "private-artifact-" + String(index),
      artifacts: [
        {
          ref,
          media_type: "text/plain",
          integrity: "sha256:fixture",
          sensitivity: "restricted" as const,
          retention: "fixture" as const,
        },
      ],
    }));
    const input = failureReportSchema.parse({
      ...report,
      evidence: privateEvidence,
    });

    const first = normalizeFailureReportArtifactReferences(input);
    const replay = normalizeFailureReportArtifactReferences(input);
    const refs = first.evidence.map((evidence) => evidence.artifacts[0]?.ref);

    expect(refs).toEqual(
      replay.evidence.map((evidence) => evidence.artifacts[0]?.ref),
    );
    expect(
      refs.every((ref) => ref?.startsWith("protected://failure-report/")),
    ).toBe(true);
    expect(first.evidence[0]?.artifacts[0]).toMatchObject({
      media_type: "text/plain",
      integrity: "sha256:fixture",
      sensitivity: "restricted",
      retention: "fixture",
    });
    expect(JSON.stringify(first)).not.toContain("alice");
    expect(JSON.stringify(first)).not.toContain("private-relative.log");
  });

  it("preserves opaque references and fails closed for credential or unsafe public refs", async () => {
    const report = await loadReport();
    expect(
      normalizeFailureReportArtifactReferences(report).inputs[1]?.artifact.ref,
    ).toBe("protected://ckboost/issue-54/replacement-nevent");
    expect(
      normalizeFailureReportArtifactReferences(report).inputs[0]?.artifact.ref,
    ).toBe("https://github.com/Alive24/CKBoost/issues/54");
    expect(
      normalizeFailureReportArtifactReferences(report).inputs[3]?.artifact.ref,
    ).toBe("conversation-evidence.md");

    const credential = failureReportSchema.parse({
      ...report,
      inputs: [
        {
          ...report.inputs[0]!,
          artifact: { ref: "ghp_0123456789", sensitivity: "restricted" },
        },
        ...report.inputs.slice(1),
      ],
    });
    expect(() => normalizeFailureReportArtifactReferences(credential)).toThrow(
      "credential-bearing artifact evidence",
    );

    const unsafePublic = failureReportSchema.parse({
      ...report,
      inputs: [
        {
          ...report.inputs[0]!,
          artifact: { ref: "private/diagnostics.log", sensitivity: "public" },
        },
        ...report.inputs.slice(1),
      ],
    });
    expect(() => normalizeFailureReportArtifactReferences(unsafePublic)).toThrow(
      "unsafe public artifact reference",
    );
  });

  it("normalizes before immutable completion equality and shares refs with projections", async () => {
    const report = await loadReport();
    const outcome: DiagnosticCompletionOutcome = {
      evidence: [
        {
          id: "completion-evidence",
          kind: "tool_observation",
          observed_fact: "Root inspected a private diagnostic artifact.",
          epistemic_status: "observed",
          provenance: {
            phase: "investigation",
            source_type: "agent",
            source_ref: "codex-thread/54",
            collector: "root",
          },
          artifacts: [
            { ref: "diagnostics/completion.log", sensitivity: "restricted" },
          ],
        },
      ],
      operation_evidence: [
        {
          id: "completion-operation",
          kind: "tool_observation",
          observed_fact: "Root ran a focused diagnostic command.",
          epistemic_status: "observed",
          provenance: {
            phase: "investigation",
            source_type: "agent",
            source_ref: "codex-thread/54",
            collector: "root",
          },
          artifacts: [
            { ref: "diagnostics/operation.log", sensitivity: "restricted" },
          ],
        },
      ],
      hypotheses: [],
      experiments: [],
    };
    const normalizedOutcome = normalizeDiagnosticCompletionArtifactReferences(
      report.id,
      outcome,
    );

    const session: DiagnosticSession = {
      lifecycle: "active",
      domain_extensions: [],
      backend_id: "codex_app_server",
      codex_thread_id: "thread-54",
      worktree: {
        identity: "session-54",
        base_revision: report.target.revision,
        head_revision: report.target.revision,
      },
      diagnostic_branch_slug: "issue-54",
    };
    const input = {
      codex_thread_id: "thread-54",
      outcome,
    };
    const first = createDiagnosticCompletionRecord({
      report,
      diagnostic_session: session,
      observed_worktree_head: report.target.revision,
      completion: input,
      completed_at: "2026-07-15T10:00:00Z",
    });
    const replay = createDiagnosticCompletionRecord({
      report,
      diagnostic_session: session,
      observed_worktree_head: report.target.revision,
      completion: input,
      completed_at: "2026-07-15T10:00:00Z",
    });
    const projected = failureReportSchema.parse({
      ...report,
      diagnostic_session: session,
      diagnostic_completions: [first],
      evidence: [
        ...report.evidence,
        ...first.outcome.evidence,
        ...first.outcome.operation_evidence,
      ],
    });
    const published = normalizeFailureReportArtifactReferences(projected);

    expect(first).toEqual(replay);
    expect(first.outcome).toEqual(normalizedOutcome);
    expect(first.outcome.evidence[0]?.artifacts[0]?.ref).toMatch(
      /^protected:\/\/failure-report\/completion\/evidence\/completion-evidence\/artifact\/0\//,
    );
    expect(first.outcome.operation_evidence[0]?.artifacts[0]?.ref).toMatch(
      /^protected:\/\/failure-report\/completion\/operation-evidence\/completion-operation\/artifact\/0\//,
    );
    expect(published.evidence.at(-2)?.artifacts[0]?.ref).toBe(
      published.diagnostic_completions?.[0]?.outcome.evidence[0]?.artifacts[0]
        ?.ref,
    );
    expect(published.evidence.at(-1)?.artifacts[0]?.ref).toBe(
      published.diagnostic_completions?.[0]?.outcome.operation_evidence[0]
        ?.artifacts[0]?.ref,
    );
  });
});
