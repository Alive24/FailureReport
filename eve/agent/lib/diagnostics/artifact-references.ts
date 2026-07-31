import { createHash } from "node:crypto";

import {
  diagnosticCompletionOutcomeSchema,
  failureReportSchema,
  type DiagnosticCompletionOutcome,
  type FailureReport,
} from "@failure-report/protocol";

type Artifact = FailureReport["inputs"][number]["artifact"];
type Evidence = FailureReport["evidence"][number];

const logicalReference = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const credentialReference =
  /(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|(?:api[_-]?key|token|secret|password|credential)\s*[:=]|bearer\s+\S+|:\/\/[^/:\s]+:[^/@\s]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

/**
 * Root's public-workpad boundary replaces non-public locations with handles
 * derived solely from report-owned logical identities. The original location
 * stays in the host-private artifact boundary and is never durable output.
 */
export function normalizeFailureReportArtifactReferences(
  report: FailureReport,
): FailureReport {
  const completionSlots = new Map<string, string>();
  for (const completion of report.diagnostic_completions ?? []) {
    for (const evidence of completion.outcome.evidence) {
      completionSlots.set(evidence.id, "completion/evidence/" + evidence.id);
    }
    for (const evidence of completion.outcome.operation_evidence) {
      completionSlots.set(
        evidence.id,
        "completion/operation-evidence/" + evidence.id,
      );
    }
  }

  return failureReportSchema.parse({
    ...report,
    inputs: report.inputs.map((input) => ({
      ...input,
      artifact: normalizeArtifact(
        report.id,
        "input/" + input.id,
        input.artifact,
      ),
    })),
    evidence: normalizeEvidence(
      report.id,
      report.evidence,
      (evidence) =>
        completionSlots.get(evidence.id) ?? "evidence/" + evidence.id,
    ),
    ...(report.diagnostic_completions
      ? {
          diagnostic_completions: report.diagnostic_completions.map(
            (completion) => ({
              ...completion,
              outcome: normalizeCompletionOutcomeArtifacts(
                report.id,
                completion.outcome,
              ),
            }),
          ),
        }
      : {}),
  });
}

/** Normalizes a completion before Root derives its immutable record. */
export function normalizeDiagnosticCompletionArtifactReferences(
  reportId: string,
  outcome: DiagnosticCompletionOutcome,
): DiagnosticCompletionOutcome {
  return normalizeCompletionOutcomeArtifacts(reportId, outcome);
}

function normalizeCompletionOutcomeArtifacts(
  reportId: string,
  outcome: DiagnosticCompletionOutcome,
): DiagnosticCompletionOutcome {
  return diagnosticCompletionOutcomeSchema.parse({
    ...outcome,
    evidence: normalizeEvidence(
      reportId,
      outcome.evidence,
      (evidence) => "completion/evidence/" + evidence.id,
    ),
    operation_evidence: normalizeEvidence(
      reportId,
      outcome.operation_evidence,
      (evidence) => "completion/operation-evidence/" + evidence.id,
    ),
  });
}

function normalizeEvidence(
  reportId: string,
  evidence: readonly Evidence[],
  slotFor: (evidence: Evidence) => string,
): Evidence[] {
  return evidence.map((entry) => ({
    ...entry,
    artifacts: entry.artifacts.map((artifact, index) =>
      normalizeArtifact(
        reportId,
        slotFor(entry) + "/artifact/" + String(index),
        artifact,
      ),
    ),
  }));
}

function normalizeArtifact(
  reportId: string,
  slot: string,
  artifact: Artifact,
): Artifact {
  if (credentialReference.test(artifact.ref)) {
    throw new Error(
      "FailureReport cannot publish credential-bearing artifact evidence.",
    );
  }
  if (artifact.sensitivity === "public") {
    if (!isPublicReference(artifact.ref)) {
      throw new Error(
        "FailureReport cannot publish an unsafe public artifact reference.",
      );
    }
    return artifact;
  }
  if (isOpaqueReference(artifact.ref)) {
    return artifact;
  }

  const identity = ["failure-report/artifact/v1", reportId, slot].join("\u0000");
  const digest = createHash("sha256").update(identity).digest("hex");
  return {
    ...artifact,
    ref: "protected://failure-report/" + slot + "/" + digest,
  };
}

function isOpaqueReference(ref: string): boolean {
  return ref.startsWith("protected://") || logicalReference.test(ref);
}

function isPublicReference(ref: string): boolean {
  if (isOpaqueReference(ref)) {
    return true;
  }
  try {
    const parsed = new URL(ref);
    return parsed.protocol !== "file:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
