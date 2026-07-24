import { createHash } from "node:crypto";

import { z } from "zod";

import type { FailureReport } from "./index.js";

const identifierSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const immutableGitRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{40,64}$/i, "revision must be a full immutable Git SHA");
const sortedIdentifierListSchema = z.array(identifierSchema);
const stringListSchema = z.array(z.string().min(1));
const implementationHandoffIdSchema = z
  .string()
  .regex(/^failure-report\/implementation-handoff\/sha256\/[0-9a-f]{64}$/);
const humanInputRequestIdSchema = z
  .string()
  .regex(/^failure-report\/human-input-request\/sha256\/[0-9a-f]{64}$/);

const workpadReferenceSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    logical_session_id: identifierSchema,
    entry_id: identifierSchema,
  })
  .strict();

const reportReferenceSchema = z
  .object({
    report_id: identifierSchema,
    issue: z
      .object({
        repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
        issue_number: z.number().int().positive(),
        issue_url: z.string().url(),
      })
      .strict(),
    workpad: workpadReferenceSchema,
  })
  .strict();

const targetReferenceSchema = z
  .object({
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    revision: immutableGitRevisionSchema,
  })
  .strict();

const verificationSchema = z
  .object({
    automated: stringListSchema.min(1),
    uat: stringListSchema,
    context: stringListSchema,
  })
  .strict();

/** Strict public contract for a finalized, consumer-neutral implementation handoff. */
export const implementationHandoffSchema = z
  .object({
    schema_version: z.literal("failure-report/implementation-handoff/v1"),
    handoff_id: implementationHandoffIdSchema,
    report: reportReferenceSchema,
    target: targetReferenceSchema,
    diagnostic_snapshot: z
      .object({
        branch: z.string().min(1),
        remote_ref: z.string().min(1),
        remote_url: z.string().url(),
        head_revision: immutableGitRevisionSchema,
        reuse_policy: z.literal("diagnostic_snapshot_only"),
      })
      .strict(),
    diagnostic_completion_ids: sortedIdentifierListSchema.min(1),
    evidence_refs: sortedIdentifierListSchema.min(1),
    contract: z
      .object({
        goal: z.string().min(1),
        why_now: z.string().min(1),
        scope_in: stringListSchema.min(1),
        scope_out: stringListSchema,
        guardrails: stringListSchema.min(1),
        required_outcomes: stringListSchema.min(1),
        verification: verificationSchema,
        uat_required: z.boolean(),
        residual_risks: stringListSchema,
      })
      .strict(),
    markdown: z.string().min(1),
  })
  .strict()
  .superRefine((handoff, context) => {
    if (
      handoff.contract.uat_required &&
      handoff.contract.verification.uat.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "uat_required requires at least one explicit UAT step",
        path: ["contract", "verification", "uat"],
      });
    }
  });

/** Strict public contract for one precise question that resumes an active diagnosis. */
export const humanInputRequestSchema = z
  .object({
    schema_version: z.literal("failure-report/human-input-request/v1"),
    request_id: humanInputRequestIdSchema,
    report: reportReferenceSchema,
    target: targetReferenceSchema,
    diagnostic_session: z
      .object({
        identity: identifierSchema,
        lifecycle: z.literal("active"),
      })
      .strict(),
    confirmed_facts: z
      .array(
        z
          .object({
            evidence_id: identifierSchema,
            fact: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    completed_or_exhausted_experiments: z
      .array(
        z
          .object({
            experiment_id: identifierSchema,
            question: z.string().min(1),
            outcome: z.enum([
              "confirmed",
              "rejected",
              "inconclusive",
              "not_run",
            ]),
            interpretation: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    eliminated_hypotheses: z
      .array(
        z
          .object({
            hypothesis_id: identifierSchema,
            statement: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    remaining_material_unknown: z.string().min(1),
    viable_options: stringListSchema
      .min(2)
      .refine(
        (options) => new Set(options).size === options.length,
        "human input options must be unique",
      ),
    question: z
      .string()
      .min(1)
      .refine(
        (question) =>
          question.trim().endsWith("?") &&
          [...question].filter((character) => character === "?").length === 1,
        "human input request must contain exactly one question",
      ),
    resume_condition: z.string().min(1),
    markdown: z.string().min(1),
  })
  .strict();

export type ImplementationHandoff = z.infer<typeof implementationHandoffSchema>;
export type HumanInputRequest = z.infer<typeof humanInputRequestSchema>;
export type DiagnosticHandoff = ImplementationHandoff | HumanInputRequest;

/** A fail-closed lifecycle or identity decision at the read-only handoff boundary. */
export class HandoffNeedsInputError extends Error {
  readonly outcome = "needs_input";

  constructor(message: string) {
    super(message);
    this.name = "HandoffNeedsInputError";
  }
}

/**
 * Renders a latest, already provenance-validated workpad report.
 *
 * The renderer has no clock, random source, gateway, or workspace dependency.
 * All set-like arrays are sorted before hashing and rendering so equivalent
 * durable state produces byte-identical output.
 */
export function renderDiagnosticHandoff(
  report: FailureReport,
): DiagnosticHandoff {
  const reference = reportReference(report);
  const target = {
    repository: report.target.repository,
    revision: report.target.revision,
  };

  if (report.handoff.human_input) {
    return renderHumanInputRequest(report, reference, target);
  }
  return renderImplementationHandoff(report, reference, target);
}

function renderImplementationHandoff(
  report: FailureReport,
  reference: z.infer<typeof reportReferenceSchema>,
  target: z.infer<typeof targetReferenceSchema>,
): ImplementationHandoff {
  const session = report.diagnostic_session;
  const snapshot = session?.diagnostic_branch;
  if (
    report.status !== "todo_ready" ||
    report.handoff.todo_status !== "ready" ||
    report.handoff.gate_decision !== "Ready"
  ) {
    throw new HandoffNeedsInputError(
      "Implementation handoff requires report status todo_ready and a fully Ready handoff gate.",
    );
  }
  if (!session || session.lifecycle !== "finalized" || !snapshot) {
    throw new HandoffNeedsInputError(
      "Implementation handoff requires a finalized diagnostic session.",
    );
  }
  if (session.worktree.base_revision !== report.target.revision) {
    throw new HandoffNeedsInputError(
      "Diagnostic session base revision does not match the immutable report target revision.",
    );
  }
  if (session.worktree.head_revision !== snapshot.head_revision) {
    throw new HandoffNeedsInputError(
      "Finalized diagnostic snapshot HEAD does not match the persisted worktree HEAD.",
    );
  }
  const expectedBranch =
    "diagnostic/" +
    String(reference.issue.issue_number) +
    "-" +
    session.diagnostic_branch_slug;
  const issueSuffix = "/issues/" + String(reference.issue.issue_number);
  const expectedRemoteUrl =
    reference.issue.issue_url.slice(0, -issueSuffix.length) +
    "/tree/" +
    expectedBranch.split("/").map(encodeURIComponent).join("/");
  if (
    !reference.issue.issue_url.endsWith(issueSuffix) ||
    snapshot.name !== expectedBranch ||
    snapshot.remote_ref !== "refs/heads/" + expectedBranch ||
    snapshot.remote_url !== expectedRemoteUrl
  ) {
    throw new HandoffNeedsInputError(
      "Finalized diagnostic snapshot references conflict with the persisted Issue-bound branch identity.",
    );
  }

  const completions = report.diagnostic_completions ?? [];
  if (completions.length === 0) {
    throw new HandoffNeedsInputError(
      "Implementation handoff requires at least one relevant diagnostic completion identity.",
    );
  }
  if (
    completions.some(
      (completion) =>
        completion.observed_worktree_head !== snapshot.head_revision,
    )
  ) {
    throw new HandoffNeedsInputError(
      "Diagnostic completion lineage does not match the finalized snapshot HEAD.",
    );
  }

  const diagnosticCompletionIds = sortedUnique(
    completions.map((completion) => completion.completion_id),
  );
  const evidenceRefs = sortedUnique([
    ...report.evidence.map((evidence) => evidence.id),
    ...completions.flatMap((completion) => [
      ...completion.outcome.evidence.map((evidence) => evidence.id),
      ...completion.outcome.operation_evidence.map((evidence) => evidence.id),
    ]),
  ]);
  if (evidenceRefs.length === 0) {
    throw new HandoffNeedsInputError(
      "Implementation handoff requires immutable evidence identities.",
    );
  }

  const identityPayload = {
    schema_version: "failure-report/implementation-handoff/v1" as const,
    report: reference,
    target,
    diagnostic_snapshot: {
      branch: snapshot.name,
      remote_ref: snapshot.remote_ref,
      remote_url: snapshot.remote_url,
      head_revision: snapshot.head_revision,
      reuse_policy: snapshot.reuse_policy,
    },
    diagnostic_completion_ids: diagnosticCompletionIds,
    evidence_refs: evidenceRefs,
    contract: {
      goal: report.handoff.goal,
      why_now: report.handoff.why_now,
      scope_in: sortedUnique(report.handoff.scope_in),
      scope_out: sortedUnique(report.handoff.scope_out),
      guardrails: sortedUnique(report.handoff.guardrails),
      required_outcomes: sortedUnique(report.handoff.required_outcomes),
      verification: {
        automated: sortedUnique(report.handoff.verification.automated),
        uat: sortedUnique(report.handoff.verification.uat),
        context: sortedUnique(report.handoff.verification.context),
      },
      uat_required: report.handoff.uat_required,
      residual_risks: sortedUnique(report.handoff.residual_risks),
    },
  };
  const handoffId = digestIdentifier("implementation-handoff", identityPayload);
  return implementationHandoffSchema.parse({
    ...identityPayload,
    handoff_id: handoffId,
    markdown: renderImplementationMarkdown(identityPayload, handoffId),
  });
}

function renderHumanInputRequest(
  report: FailureReport,
  reference: z.infer<typeof reportReferenceSchema>,
  target: z.infer<typeof targetReferenceSchema>,
): HumanInputRequest {
  const humanInput = report.handoff.human_input;
  const session = report.diagnostic_session;
  if (!humanInput) {
    throw new HandoffNeedsInputError(
      "Human-input rendering requires a durable human-input specification.",
    );
  }
  if (
    report.status !== "needs_input" ||
    report.handoff.todo_status !== "not_ready" ||
    report.handoff.gate_decision !== "Need to Clarify"
  ) {
    throw new HandoffNeedsInputError(
      "Human-input request requires needs_input report state and a Need to Clarify gate.",
    );
  }
  if (!session || session.lifecycle !== "active" || session.diagnostic_branch) {
    throw new HandoffNeedsInputError(
      "Human-input request must preserve an active, unfinalized diagnostic session.",
    );
  }
  if (!session.codex_thread_id) {
    throw new HandoffNeedsInputError(
      "Human-input request requires the persisted diagnostic thread to remain resumable.",
    );
  }
  if (session.worktree.base_revision !== report.target.revision) {
    throw new HandoffNeedsInputError(
      "Active diagnostic session does not match the immutable report target revision.",
    );
  }

  const confirmedFacts = report.evidence
    .filter((evidence) =>
      ["observed", "verified"].includes(evidence.epistemic_status),
    )
    .map((evidence) => ({
      evidence_id: evidence.id,
      fact: evidence.observed_fact,
    }))
    .sort((left, right) => compareStrings(left.evidence_id, right.evidence_id));
  const experiments = report.experiments
    .map((experiment) => ({
      experiment_id: experiment.id,
      question: experiment.question,
      outcome: experiment.outcome,
      interpretation: experiment.interpretation,
    }))
    .sort((left, right) =>
      compareStrings(left.experiment_id, right.experiment_id),
    );
  const eliminatedHypotheses = report.hypotheses
    .filter((hypothesis) => hypothesis.status === "rejected")
    .map((hypothesis) => ({
      hypothesis_id: hypothesis.id,
      statement: hypothesis.statement,
    }))
    .sort((left, right) =>
      compareStrings(left.hypothesis_id, right.hypothesis_id),
    );
  if (confirmedFacts.length === 0) {
    throw new HandoffNeedsInputError(
      "Human-input request requires at least one confirmed observed or verified fact.",
    );
  }
  if (experiments.length === 0) {
    throw new HandoffNeedsInputError(
      "Human-input request requires completed or explicitly exhausted experiment evidence.",
    );
  }
  if (eliminatedHypotheses.length === 0) {
    throw new HandoffNeedsInputError(
      "Human-input request requires at least one eliminated hypothesis.",
    );
  }

  const identityPayload = {
    schema_version: "failure-report/human-input-request/v1" as const,
    report: reference,
    target,
    diagnostic_session: {
      identity: session.worktree.identity,
      lifecycle: "active" as const,
    },
    confirmed_facts: confirmedFacts,
    completed_or_exhausted_experiments: experiments,
    eliminated_hypotheses: eliminatedHypotheses,
    remaining_material_unknown: humanInput.remaining_material_unknown,
    viable_options: sortedUnique(humanInput.viable_options),
    question: humanInput.question,
    resume_condition: humanInput.resume_condition,
  };
  const requestId = digestIdentifier("human-input-request", identityPayload);
  return humanInputRequestSchema.parse({
    ...identityPayload,
    request_id: requestId,
    markdown: renderHumanInputMarkdown(identityPayload, requestId),
  });
}

function reportReference(
  report: FailureReport,
): z.infer<typeof reportReferenceSchema> {
  const issue = report.shared_context;
  if (!issue?.workpad_logical_session_id || !issue.workpad_entry_id) {
    throw new HandoffNeedsInputError(
      "Handoff rendering requires the latest persisted managed workpad identity.",
    );
  }
  if (issue.repository !== report.target.repository) {
    throw new HandoffNeedsInputError(
      "Report Issue repository and immutable target repository do not match.",
    );
  }
  return reportReferenceSchema.parse({
    report_id: report.id,
    issue: {
      repository: issue.repository,
      issue_number: issue.issue_number,
      issue_url: issue.issue_url,
    },
    workpad: {
      revision: issue.workpad_revision,
      logical_session_id: issue.workpad_logical_session_id,
      entry_id: issue.workpad_entry_id,
    },
  });
}

function digestIdentifier(kind: string, value: unknown): string {
  return (
    "failure-report/" +
    kind +
    "/sha256/" +
    createHash("sha256").update(canonicalJson(value)).digest("hex")
  );
}

/** Canonical JSON used only for deterministic identity derivation. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/** Locale-independent UTF-16 ordering for identities rendered on any host. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderImplementationMarkdown(
  handoff: Omit<ImplementationHandoff, "handoff_id" | "markdown">,
  handoffId: string,
): string {
  return [
    "# Implementation Handoff",
    "",
    "- Schema: `" + handoff.schema_version + "`",
    "- Handoff ID: `" + handoffId + "`",
    "- Report: `" + handoff.report.report_id + "`",
    "- Workpad revision: `" + String(handoff.report.workpad.revision) + "`",
    "- Target: `" +
      handoff.target.repository +
      "@" +
      handoff.target.revision +
      "`",
    "- Diagnostic snapshot: `" +
      handoff.diagnostic_snapshot.remote_ref +
      "@" +
      handoff.diagnostic_snapshot.head_revision +
      "` (`diagnostic_snapshot_only`)",
    "",
    "## Goal",
    "",
    handoff.contract.goal,
    "",
    "## Why now",
    "",
    handoff.contract.why_now,
    "",
    "## Scope in",
    "",
    ...bullets(handoff.contract.scope_in),
    "",
    "## Scope out",
    "",
    ...bullets(handoff.contract.scope_out),
    "",
    "## Guardrails",
    "",
    ...bullets(handoff.contract.guardrails),
    "",
    "## Required outcomes",
    "",
    ...bullets(handoff.contract.required_outcomes),
    "",
    "## Verification",
    "",
    "### Automated",
    "",
    ...bullets(handoff.contract.verification.automated),
    "",
    "### UAT",
    "",
    ...(handoff.contract.verification.uat.length > 0
      ? bullets(handoff.contract.verification.uat)
      : ["- Not required."]),
    "",
    "### Context",
    "",
    ...bullets(handoff.contract.verification.context),
    "",
    "## Immutable evidence references",
    "",
    ...bullets(handoff.evidence_refs.map((ref) => "`" + ref + "`")),
    "",
    "## Residual risks",
    "",
    ...(handoff.contract.residual_risks.length > 0
      ? bullets(handoff.contract.residual_risks)
      : ["- None recorded."]),
    "",
  ].join("\n");
}

function renderHumanInputMarkdown(
  request: Omit<HumanInputRequest, "request_id" | "markdown">,
  requestId: string,
): string {
  return [
    "# Need Human Input",
    "",
    "- Schema: `" + request.schema_version + "`",
    "- Request ID: `" + requestId + "`",
    "- Report: `" + request.report.report_id + "`",
    "- Workpad revision: `" + String(request.report.workpad.revision) + "`",
    "- Diagnostic session: `" +
      request.diagnostic_session.identity +
      "` (active)",
    "",
    "## Confirmed facts",
    "",
    ...bullets(
      request.confirmed_facts.map(
        (fact) => "`" + fact.evidence_id + "` — " + fact.fact,
      ),
    ),
    "",
    "## Completed or exhausted experiments",
    "",
    ...bullets(
      request.completed_or_exhausted_experiments.map(
        (experiment) =>
          "`" +
          experiment.experiment_id +
          "` (" +
          experiment.outcome +
          ") — " +
          experiment.interpretation,
      ),
    ),
    "",
    "## Eliminated hypotheses",
    "",
    ...bullets(
      request.eliminated_hypotheses.map(
        (hypothesis) =>
          "`" + hypothesis.hypothesis_id + "` — " + hypothesis.statement,
      ),
    ),
    "",
    "## Remaining material unknown",
    "",
    request.remaining_material_unknown,
    "",
    "## Viable options",
    "",
    ...bullets(request.viable_options),
    "",
    "## Question",
    "",
    request.question,
    "",
    "## Resume condition",
    "",
    request.resume_condition,
    "",
  ].join("\n");
}

function bullets(values: readonly string[]): string[] {
  return values.map((value) => "- " + value.replace(/\r?\n/g, "\n  "));
}
