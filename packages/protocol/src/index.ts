import { createHash } from "node:crypto";

import { z } from "zod";

import {
  handoffDeliveryReceiptSchema,
  humanInputRequestSchema,
  implementationHandoffSchema,
} from "./handoff.js";
import {
  renderFailureReportWorkpadHumanView as renderWorkpadHumanView,
  type FailureReportWorkpadAuthority,
} from "./workpad-human-view.js";

export {
  HandoffNeedsInputError,
  handoffDeliveryReceiptSchema,
  humanInputRequestSchema,
  implementationHandoffSchema,
  renderDiagnosticHandoff,
  type DiagnosticHandoff,
  type HandoffDeliveryReceipt,
  type HumanInputRequest,
  type ImplementationHandoff,
} from "./handoff.js";
export type { FailureReportWorkpadAuthority } from "./workpad-human-view.js";

/**
 * Canonical runtime and persistence contract for FailureReport.
 *
 * Every transport parses untrusted input through these schemas before it reaches
 * Root, and the GitHub workpad uses the same schemas when it is rehydrated.
 */

/** Marker used to locate the one structured FailureReport workpad comment. */
export const workpadMarker = "<!-- failure-report-workpad -->";
/** Versioned delimiter around one immutable entry in a managed workpad comment. */
export const workpadEntryStartMarker =
  "<!-- failure-report-workpad-entry/v2 -->";
/** Closing delimiter for a managed v2 workpad entry. */
export const workpadEntryEndMarker = "<!-- /failure-report-workpad-entry -->";
/** Marker used only for a folded, non-authoritative provisional chunk. */
export const workpadChunkMarker = "<!-- failure-report-workpad-chunk/v1 -->";
/** Delimiter around the authoritative commit record for a chunk group. */
export const workpadManifestStartMarker =
  "<!-- failure-report-workpad-manifest/v1 -->";
/** Closing delimiter for a managed chunk-group manifest. */
export const workpadManifestEndMarker =
  "<!-- /failure-report-workpad-manifest -->";

/** Shared primitive for IDs that may safely appear in report and transport keys. */
const identifierSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);

/** A full SHA-1 or SHA-256 Git object identity; selectors are not source targets. */
const immutableGitRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{40,64}$/i, "revision must be a full immutable Git SHA");

const timestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
  );

const stringListSchema = z.array(z.string().min(1));

/** Canonical identity pieces shared by initial Issue selectors and workpad context. */
const githubRepositorySchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const githubIssueNumberSchema = z.number().int().positive();

const artifactSchema = z
  .object({
    ref: z.string().min(1),
    media_type: z.string().min(1).optional(),
    integrity: z.string().min(1).optional(),
    sensitivity: z.enum(["public", "internal", "restricted", "secret"]),
    retention: z.enum(["ephemeral", "fixture", "durable"]).optional(),
  })
  .strict();

const provenanceSchema = z
  .object({
    phase: z.enum([
      "intake",
      "investigation",
      "human_decision",
      "implementation",
      "review",
      "uat",
    ]),
    source_type: z.enum([
      "human",
      "issue",
      "conversation",
      "tool",
      "repository",
      "runtime",
      "test",
      "agent",
    ]),
    source_ref: z.string().min(1),
    collector: z.string().min(1),
    collected_at: timestampSchema.optional(),
    method: z.string().min(1).optional(),
  })
  .strict();

const relatedWorkSchema = z
  .object({
    kind: z.enum([
      "github_issue",
      "commit",
      "pull_request",
      "conversation",
      "document",
    ]),
    ref: z.string().min(1),
  })
  .strict();

const environmentEntrySchema = z
  .object({
    name: z.string().min(1),
    value: z.string(),
  })
  .strict();

const verificationSchema = z
  .object({
    automated: stringListSchema,
    uat: stringListSchema,
    context: stringListSchema,
  })
  .strict();

/**
 * Validates the minimal identity a caller may use to begin existing-Issue intake.
 *
 * This is deliberately not a partial workpad context: Root must read GitHub to
 * derive the URL, workpad state, and canonical context before it resumes work.
 */
export const githubIssueSelectorSchema = z
  .object({
    repository: githubRepositorySchema,
    issue_number: githubIssueNumberSchema,
  })
  .strict();

/**
 * Validates the GitHub Issue binding stored alongside a report.
 *
 * This deliberately carries only collaboration metadata; diagnostic session state lives
 * separately so a backend-specific resume token cannot become shared context.
 */
export const githubIssueContextSchema = z
  .object({
    provider: z.literal("github_issue"),
    repository: githubRepositorySchema,
    issue_number: githubIssueNumberSchema,
    issue_url: z.string().min(1),
    workpad_marker: z.literal(workpadMarker),
    workpad_comment_ref: z.string().min(1).optional(),
    workpad_revision: z.number().int().nonnegative(),
    workpad_logical_session_id: identifierSchema.optional(),
    workpad_entry_id: identifierSchema.optional(),
    workpad_producer_id: identifierSchema.optional(),
    workpad_predecessor_comment_ref: z.string().min(1).optional(),
    synced_at: timestampSchema.optional(),
  })
  .strict();

/**
 * Validates the durable identity and Git revisions of an isolated worktree.
 *
 * The host-local path is runtime state owned by Root and must never enter the
 * public FailureReport workpad.
 */
export const diagnosticWorktreeSchema = z
  .object({
    identity: z.string().min(1),
    base_revision: immutableGitRevisionSchema,
    head_revision: immutableGitRevisionSchema,
  })
  .strict();

/** A human-readable, persisted portion of a diagnostic snapshot branch name. */
const diagnosticBranchSlugPattern = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u;

export const diagnosticBranchSlugSchema = z
  .string()
  .min(1)
  .max(80)
  // Keep this runtime-only: OpenAI rejects JSON Schema `pattern` values using
  // Unicode property escapes, while persisted Unicode Issue-title slugs remain
  // valid Git ref components.
  .refine((slug) => diagnosticBranchSlugPattern.test(slug), {
    message: "diagnostic branch slug must be a non-empty safe Issue-title slug",
  });

/**
 * Derives the persisted, human-readable title portion of a diagnostic branch.
 *
 * Keeping this alongside the slug contract ensures new sessions and narrowly
 * supported legacy-session repair use exactly the same deterministic rule.
 */
export function diagnosticBranchSlugFor(issueTitle: string): string {
  const normalized = issueTitle
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  let bounded = "";
  for (const character of normalized) {
    if (bounded.length + character.length > 80) {
      break;
    }
    bounded += character;
  }
  return bounded.replace(/-+$/g, "") || "diagnostic";
}

/** A finalized, diagnostic-only Git snapshot. */
export const diagnosticBranchSchema = z
  .object({
    name: z.string().min(1),
    head_revision: immutableGitRevisionSchema,
    remote_name: z.literal("origin"),
    remote_ref: z.string().min(1),
    remote_url: z.string().url(),
    pushed_at: timestampSchema,
    finalized_at: timestampSchema,
    reuse_policy: z.literal("diagnostic_snapshot_only"),
  })
  .strict();

/**
 * Canonical Root-selected extension set for a diagnosis.
 *
 * The ordering is part of the durable contract so worktree identity, symlink
 * materialization, and rendered native-skill delegation stay deterministic.
 */
export const diagnosticDomainExtensionsSchema = z
  .array(identifierSchema)
  .superRefine((extensions, context) => {
    for (let index = 0; index < extensions.length; index += 1) {
      const current = extensions[index];
      const previous = extensions[index - 1];
      if (previous && current && previous >= current) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "domain_extensions must be unique and sorted in ascending order",
          path: [index],
        });
      }
    }
  });

/** Evidence a Root-owned diagnostic completion may project into its report. */
const diagnosticCompletionEvidenceSchema = z
  .object({
    id: identifierSchema,
    kind: z.enum([
      "reported_observation",
      "tool_observation",
      "repository_fact",
      "derived_finding",
      "human_decision",
      "review_finding",
      "uat_result",
    ]),
    observed_fact: z.string().min(1),
    interpretation: z.string().optional(),
    epistemic_status: z.enum(["reported", "observed", "derived", "verified"]),
    provenance: provenanceSchema,
    artifacts: z.array(artifactSchema),
  })
  .strict();

/** A hypothesis a completed diagnostic may add without replacing newer state. */
const diagnosticCompletionHypothesisSchema = z
  .object({
    id: identifierSchema,
    statement: z.string().min(1),
    status: z.enum(["open", "supported", "confirmed", "rejected"]),
    supporting_evidence: z.array(identifierSchema),
    contradicting_evidence: z.array(identifierSchema),
    history: z
      .array(
        z
          .object({
            status: z.enum(["open", "supported", "confirmed", "rejected"]),
            rationale: z.string().min(1),
            provenance: provenanceSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** An experiment is the existing report representation for operation evidence. */
const diagnosticCompletionExperimentSchema = z
  .object({
    id: identifierSchema,
    question: z.string().min(1),
    proposed_action: z.string().min(1),
    approval: z
      .object({
        required: z.boolean(),
        status: z.enum(["not_required", "pending", "approved", "rejected"]),
        authority: z.string().min(1).optional(),
      })
      .strict(),
    baseline_evidence: z.array(identifierSchema),
    result_evidence: z.array(identifierSchema),
    outcome: z.enum(["confirmed", "rejected", "inconclusive", "not_run"]),
    interpretation: z.string(),
  })
  .strict();

/** A conclusion projected by Root only after its completion record is validated. */
const diagnosticCompletionConclusionSchema = z
  .object({
    diagnosis: z.string().min(1),
    confidence: z
      .object({
        level: z.enum(["low", "medium", "high"]),
        basis: z.string().min(1),
      })
      .strict(),
    remaining_uncertainty: stringListSchema,
    recommended_remediation: stringListSchema,
  })
  .strict();

/**
 * Explicit fields Root may carry from a validated Codex outcome. Operation
 * evidence remains normal report evidence or experiments; no provider-specific
 * execution transcript becomes public workpad state.
 */
export const diagnosticCompletionOutcomeSchema = z
  .object({
    report_status: z
      .enum(["diagnosed", "needs_input", "inconclusive", "blocked"])
      .optional(),
    evidence: z.array(diagnosticCompletionEvidenceSchema),
    operation_evidence: z.array(diagnosticCompletionEvidenceSchema),
    hypotheses: z.array(diagnosticCompletionHypothesisSchema),
    experiments: z.array(diagnosticCompletionExperimentSchema),
    conclusion: diagnosticCompletionConclusionSchema.optional(),
  })
  .strict();

/** Root-generated metadata for one immutable completed Codex diagnostic. */
export const diagnosticCompletionMetadataSchema = z
  .object({
    completed_at: timestampSchema,
    owner: z.literal("root"),
    provider: z.literal("codex_app_server"),
    provider_finish_reason: z.string().min(1).optional(),
  })
  .strict();

/**
 * One immutable, idempotently addressed diagnostic completion. The identity is
 * derived by Root from the report, active diagnostic session, persisted thread,
 * and observed diagnostic-worktree HEAD; it is deliberately independent of a
 * mutable workpad revision.
 */
export const diagnosticCompletionRecordSchema = z
  .object({
    schema_version: z.literal("failure-report/diagnostic-completion/v1"),
    completion_id: identifierSchema,
    report_id: identifierSchema,
    target_revision: immutableGitRevisionSchema,
    diagnostic_session_identity: identifierSchema,
    codex_thread_id: z.string().min(1),
    observed_worktree_head: immutableGitRevisionSchema,
    outcome: diagnosticCompletionOutcomeSchema,
    metadata: diagnosticCompletionMetadataSchema,
  })
  .strict();

/** Terminal outcome retained for one backend-native approval lifecycle. */
export const nativeApprovalTerminalStatusSchema = z.enum([
  "resolved",
  "denied",
  "cancelled",
  "timed_out",
  "interrupted",
]);

/** Sanitized explanation for a terminal native-approval lifecycle. */
export const nativeApprovalTerminalReasonSchema = z.enum([
  "duplicate_request",
  "identity_mismatch",
  "stale_session",
  "concurrent_request",
  "cancelled_by_backend",
  "timeout",
  "process_interrupted",
  "response_delivery_failed",
]);

/**
 * Durable, provider-neutral evidence for a native approval lifecycle.
 *
 * The broker generates `approval_id`; it is not an App Server request id. Raw
 * request ids, commands, paths, arguments, tokens, and connection state remain
 * live transport details and are intentionally absent from this schema.
 */
export const nativeApprovalTerminalEvidenceSchema = z
  .object({
    schema_version: z.literal("failure-report/native-approval-terminal/v1"),
    approval_id: identifierSchema,
    backend_id: identifierSchema,
    diagnostic_session_identity: identifierSchema,
    turn_id: identifierSchema.optional(),
    status: nativeApprovalTerminalStatusSchema,
    decision: z.enum(["approve", "deny"]).optional(),
    reason: nativeApprovalTerminalReasonSchema.optional(),
    recorded_at: timestampSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.status === "resolved" && !evidence.decision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a resolved native approval requires its normalized decision",
        path: ["decision"],
      });
    }
    if (evidence.status !== "resolved" && evidence.decision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "only a resolved native approval may retain a normalized decision",
        path: ["decision"],
      });
    }
  });

/**
 * Validates durable backend state required to resume an isolated diagnostic session.
 * The state belongs to the report but is intentionally outside `shared_context`.
 */
export const diagnosticSessionSchema = z
  .object({
    lifecycle: z.enum(["active", "finalized"]),
    domain_extensions: diagnosticDomainExtensionsSchema,
    backend_id: identifierSchema,
    codex_thread_id: z.string().min(1).optional(),
    worktree: diagnosticWorktreeSchema,
    diagnostic_branch_slug: diagnosticBranchSlugSchema,
    diagnostic_branch: diagnosticBranchSchema.optional(),
    last_diagnosed_at: timestampSchema.optional(),
    /** Sanitized terminal evidence; no live provider request is resumable. */
    native_approval_evidence: z
      .array(nativeApprovalTerminalEvidenceSchema)
      .optional(),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.lifecycle === "active" && session.diagnostic_branch) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an active diagnostic session cannot have a diagnostic_branch",
        path: ["diagnostic_branch"],
      });
    }
    if (session.lifecycle === "finalized" && !session.diagnostic_branch) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a finalized diagnostic session requires a diagnostic_branch",
        path: ["diagnostic_branch"],
      });
    }

    const approvalIds = new Set<string>();
    for (
      let index = 0;
      index < (session.native_approval_evidence?.length ?? 0);
      index += 1
    ) {
      const evidence = session.native_approval_evidence?.[index];
      if (!evidence) {
        continue;
      }
      if (approvalIds.has(evidence.approval_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "native approval evidence ids must be unique",
          path: ["native_approval_evidence", index, "approval_id"],
        });
      }
      approvalIds.add(evidence.approval_id);
      if (evidence.backend_id !== session.backend_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "native approval evidence must match the session backend",
          path: ["native_approval_evidence", index, "backend_id"],
        });
      }
      if (evidence.diagnostic_session_identity !== session.worktree.identity) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "native approval evidence must match the session worktree identity",
          path: [
            "native_approval_evidence",
            index,
            "diagnostic_session_identity",
          ],
        });
      }
    }
  });

/**
 * Validates the complete evidence-backed failure report persisted in a workpad.
 *
 * `.strict()` is intentional throughout this contract: silently accepting an
 * unknown field would make a corrupted or future-incompatible workpad appear
 * trustworthy to a currently running Root.
 */
export const failureReportSchema = z
  .object({
    $schema: z.string().optional(),
    id: identifierSchema,
    schema_version: z.literal("failure-report/v1"),
    status: z.enum([
      "intake",
      "investigating",
      "waiting",
      "diagnosed",
      "todo_ready",
      "needs_input",
      "inconclusive",
      "blocked",
      "superseded",
    ]),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    shared_context: githubIssueContextSchema.optional(),
    diagnostic_session: diagnosticSessionSchema.optional(),
    /** Immutable Root-owned completions projected into this report. */
    diagnostic_completions: z
      .array(diagnosticCompletionRecordSchema)
      .optional(),
    origin: z
      .object({
        source: z.enum([
          "codex",
          "failure_forge",
          "symphony",
          "github_issue",
          "manual",
        ]),
        reporter: z.string().min(1),
        related_work: z.array(relatedWorkSchema),
      })
      .strict(),
    target: z
      .object({
        repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
        // Callers must bind a report before Root creates a diagnostic session;
        // selectors such as HEAD and branch names are intentionally rejected.
        revision: immutableGitRevisionSchema,
        components: z.array(z.string().min(1)).min(1),
        environment: z.array(environmentEntrySchema),
      })
      .strict(),
    severity: z.enum(["low", "medium", "high", "critical"]),
    symptom: z
      .object({
        observed_behavior: stringListSchema,
        expected_behavior: stringListSchema,
        raw_error_summary: z.string(),
        first_seen_at: timestampSchema.nullable(),
        reproduction: z
          .object({
            preconditions: stringListSchema,
            steps: stringListSchema,
            frequency: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    inputs: z
      .array(
        z
          .object({
            id: identifierSchema,
            kind: z.string().min(1),
            artifact: artifactSchema,
            provenance: provenanceSchema,
          })
          .strict(),
      )
      .min(1),
    evidence: z
      .array(
        z
          .object({
            id: identifierSchema,
            kind: z.enum([
              "reported_observation",
              "tool_observation",
              "repository_fact",
              "derived_finding",
              "human_decision",
              "review_finding",
              "uat_result",
            ]),
            observed_fact: z.string().min(1),
            interpretation: z.string().optional(),
            epistemic_status: z.enum([
              "reported",
              "observed",
              "derived",
              "verified",
            ]),
            provenance: provenanceSchema,
            artifacts: z.array(artifactSchema),
          })
          .strict(),
      )
      .min(1),
    hypotheses: z.array(
      z
        .object({
          id: identifierSchema,
          statement: z.string().min(1),
          status: z.enum(["open", "supported", "confirmed", "rejected"]),
          supporting_evidence: z.array(identifierSchema),
          contradicting_evidence: z.array(identifierSchema),
          history: z
            .array(
              z
                .object({
                  status: z.enum([
                    "open",
                    "supported",
                    "confirmed",
                    "rejected",
                  ]),
                  rationale: z.string().min(1),
                  provenance: provenanceSchema,
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    ),
    decisions: z.array(
      z
        .object({
          id: identifierSchema,
          kind: z.enum([
            "architecture",
            "product",
            "safety",
            "scope",
            "implementation",
            "evaluation",
          ]),
          statement: z.string().min(1),
          status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
          authority: z.enum(["human", "agent", "system"]),
          rationale: z.string().min(1),
          evidence_refs: z.array(identifierSchema),
          provenance: provenanceSchema,
        })
        .strict(),
    ),
    experiments: z.array(
      z
        .object({
          id: identifierSchema,
          question: z.string().min(1),
          proposed_action: z.string().min(1),
          approval: z
            .object({
              required: z.boolean(),
              status: z.enum([
                "not_required",
                "pending",
                "approved",
                "rejected",
              ]),
              authority: z.string().min(1).optional(),
            })
            .strict(),
          baseline_evidence: z.array(identifierSchema),
          result_evidence: z.array(identifierSchema),
          outcome: z.enum(["confirmed", "rejected", "inconclusive", "not_run"]),
          interpretation: z.string(),
        })
        .strict(),
    ),
    conclusion: z
      .object({
        diagnosis: z.string().min(1),
        confidence: z
          .object({
            level: z.enum(["low", "medium", "high"]),
            basis: z.string().min(1),
          })
          .strict(),
        remaining_uncertainty: stringListSchema,
        recommended_remediation: stringListSchema,
      })
      .strict(),
    handoff: z
      .object({
        todo_status: z.enum(["not_ready", "ready", "published"]),
        gate_decision: z.enum([
          "Ready",
          "Need to Clarify",
          "Too Broad",
          "Blocked",
          "Duplicate / Already Covered",
        ]),
        uat_required: z.boolean(),
        goal: z.string().min(1),
        why_now: z.string().min(1),
        scope_in: stringListSchema,
        scope_out: stringListSchema,
        guardrails: stringListSchema,
        required_outcomes: stringListSchema,
        verification: verificationSchema,
        /** Non-blocking concerns that cannot change the implementation contract. */
        residual_risks: stringListSchema,
        /** One durable question specification while material uncertainty remains. */
        human_input: z
          .object({
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
                  [...question].filter((character) => character === "?")
                    .length === 1,
                "human input request must contain exactly one question",
              ),
            resume_condition: z.string().min(1),
          })
          .strict()
          .optional(),
        issue_ref: z.string().min(1).optional(),
      })
      .strict(),
    domain: z
      .object({
        pack_id: identifierSchema,
        pack_version: z.string().min(1),
        schema_ref: z.string().min(1),
        extension_data: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    const humanInput = report.handoff.human_input;
    if (
      report.handoff.todo_status === "ready" &&
      report.handoff.gate_decision !== "Ready"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "todo_status ready requires the fully Ready gate decision",
        path: ["handoff", "gate_decision"],
      });
    }
    if (
      report.handoff.gate_decision === "Ready" &&
      !["ready", "published"].includes(report.handoff.todo_status)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "the Ready gate requires todo_status ready or a separately acknowledged published state",
        path: ["handoff", "todo_status"],
      });
    }
    if (
      humanInput &&
      (report.status !== "needs_input" ||
        report.handoff.todo_status !== "not_ready" ||
        report.handoff.gate_decision !== "Need to Clarify")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "human_input requires needs_input status, not_ready todo status, and Need to Clarify gate",
        path: ["handoff", "human_input"],
      });
    }
    if (
      report.handoff.uat_required &&
      report.handoff.verification.uat.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "uat_required requires at least one explicit UAT step",
        path: ["handoff", "verification", "uat"],
      });
    }
    const remainingUncertainty = new Set(
      report.conclusion.remaining_uncertainty,
    );
    const classifiedUncertainty = new Set(report.handoff.residual_risks);
    if (humanInput) {
      classifiedUncertainty.add(humanInput.remaining_material_unknown);
    }
    if (
      ((report.status === "todo_ready" &&
        report.handoff.gate_decision === "Ready") ||
        humanInput) &&
      (remainingUncertainty.size !== classifiedUncertainty.size ||
        [...remainingUncertainty].some(
          (uncertainty) => !classifiedUncertainty.has(uncertainty),
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "every remaining uncertainty must be classified as a non-blocking residual risk or the one material human-input unknown",
        path: ["conclusion", "remaining_uncertainty"],
      });
    }

    const completions = report.diagnostic_completions ?? [];
    if (completions.length === 0) {
      return;
    }
    const session = report.diagnostic_session;
    if (!session) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "diagnostic completions require a persisted diagnostic session",
        path: ["diagnostic_completions"],
      });
      return;
    }

    const completionIds = new Set<string>();
    for (let index = 0; index < completions.length; index += 1) {
      const completion = completions[index];
      if (!completion) {
        continue;
      }
      if (completionIds.has(completion.completion_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "diagnostic completion identities must be unique",
          path: ["diagnostic_completions", index, "completion_id"],
        });
      }
      completionIds.add(completion.completion_id);
      if (completion.report_id !== report.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "diagnostic completion must belong to this report",
          path: ["diagnostic_completions", index, "report_id"],
        });
      }
      if (completion.target_revision !== report.target.revision) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "diagnostic completion must preserve the report target revision",
          path: ["diagnostic_completions", index, "target_revision"],
        });
      }
      if (
        completion.diagnostic_session_identity !== session.worktree.identity
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "diagnostic completion must belong to the active session",
          path: [
            "diagnostic_completions",
            index,
            "diagnostic_session_identity",
          ],
        });
      }
      if (completion.codex_thread_id !== session.codex_thread_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "diagnostic completion must match the persisted Codex thread",
          path: ["diagnostic_completions", index, "codex_thread_id"],
        });
      }
    }
  });

/** Operations exposed by the single public Root entry point. */
export const rootOperationSchema = z.enum([
  "start",
  "resume",
  "inspect",
  "render_handoff",
  "deliver_handoff",
]);

/** Validates an adapter request before it is handed to Root. */
export const rootRequestSchema = z
  .object({
    request_id: identifierSchema,
    operation: rootOperationSchema,
    report: failureReportSchema.optional(),
    issue_selector: githubIssueSelectorSchema.optional(),
    issue: githubIssueContextSchema.optional(),
    message: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.issue_selector && request.issue) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "provide either issue_selector or a fully rehydrated issue context, not both",
        path: ["issue_selector"],
      });
    }

    const reportIssue = request.report?.shared_context;
    if (
      request.issue_selector &&
      reportIssue &&
      (request.issue_selector.repository !== reportIssue.repository ||
        request.issue_selector.issue_number !== reportIssue.issue_number)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "issue_selector must identify the same Issue as report.shared_context",
        path: ["issue_selector"],
      });
    }
    if (
      request.issue &&
      reportIssue &&
      (request.issue.repository !== reportIssue.repository ||
        request.issue.issue_number !== reportIssue.issue_number ||
        request.issue.workpad_revision !== reportIssue.workpad_revision)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "issue context must match report.shared_context identity and revision",
        path: ["issue"],
      });
    }

    if (
      request.operation === "render_handoff" ||
      request.operation === "deliver_handoff"
    ) {
      if (!request.report?.shared_context) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${request.operation} requires the caller's persisted report binding so Root can reject stale state`,
          path: ["report"],
        });
      }
      if (
        reportIssue &&
        (!reportIssue.workpad_logical_session_id ||
          !reportIssue.workpad_entry_id)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${request.operation} requires a persisted workpad logical-session and entry identity`,
          path: ["report", "shared_context"],
        });
      }
      if (request.issue_selector) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${request.operation} requires a revision-bound report, not a minimal Issue selector`,
          path: ["issue_selector"],
        });
      }
    }
  });

/** Validates the only result shape adapters are allowed to return to callers. */
export const rootResultSchema = z
  .object({
    request_id: identifierSchema,
    status: z.enum(["accepted", "completed", "needs_input", "failed"]),
    report: failureReportSchema.optional(),
    issue: githubIssueContextSchema.optional(),
    summary: z.string().min(1),
    implementation_handoff: implementationHandoffSchema.optional(),
    handoff_delivery: handoffDeliveryReceiptSchema.optional(),
    human_input_request: humanInputRequestSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.implementation_handoff && result.human_input_request) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "implementation_handoff and human_input_request are mutually exclusive",
        path: ["implementation_handoff"],
      });
    }
    if (result.implementation_handoff && result.status !== "completed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "implementation_handoff requires completed Root status",
        path: ["status"],
      });
    }
    if (result.handoff_delivery && !result.implementation_handoff) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "handoff_delivery requires the matching implementation_handoff",
        path: ["handoff_delivery"],
      });
    }
    if (
      result.handoff_delivery &&
      result.implementation_handoff &&
      result.handoff_delivery.handoff_id !==
        result.implementation_handoff.handoff_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "handoff_delivery must acknowledge the returned implementation_handoff",
        path: ["handoff_delivery", "handoff_id"],
      });
    }
    if (result.human_input_request && result.status !== "needs_input") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human_input_request requires needs_input Root status",
        path: ["status"],
      });
    }
  });

/** Typed FailureReport value inferred from the durable schema. */
export type FailureReport = z.infer<typeof failureReportSchema>;
/** Typed GitHub Issue context inferred from the durable schema. */
export type GithubIssueContext = z.infer<typeof githubIssueContextSchema>;
/** Typed minimal GitHub Issue identity accepted for first intake and retry. */
export type GithubIssueSelector = z.infer<typeof githubIssueSelectorSchema>;
/** Typed durable diagnostic-session state inferred from the durable schema. */
export type DiagnosticSession = z.infer<typeof diagnosticSessionSchema>;
/** Typed immutable Root-owned completion record inferred from the durable schema. */
export type DiagnosticCompletionRecord = z.infer<
  typeof diagnosticCompletionRecordSchema
>;
/** Typed report fields a completion is permitted to project. */
export type DiagnosticCompletionOutcome = z.infer<
  typeof diagnosticCompletionOutcomeSchema
>;
/** Typed Root-generated metadata paired with a completion record. */
export type DiagnosticCompletionMetadata = z.infer<
  typeof diagnosticCompletionMetadataSchema
>;
/** Typed durable terminal evidence for a backend-native approval request. */
export type NativeApprovalTerminalEvidence = z.infer<
  typeof nativeApprovalTerminalEvidenceSchema
>;
/** Typed isolated diagnostic-worktree identity inferred from the durable schema. */
export type DiagnosticWorktree = z.infer<typeof diagnosticWorktreeSchema>;
/** Typed public Root request inferred from the transport schema. */
export type RootRequest = z.infer<typeof rootRequestSchema>;
/** Typed public Root result inferred from the transport schema. */
export type RootResult = z.infer<typeof rootResultSchema>;

/**
 * Type-only invocation contract shared by outer ecosystem wrappers.
 *
 * It belongs beside `RootRequest` and `RootResult`: implementations call the
 * default Eve Channel, while MCP and Temporal stay independent of one another.
 */
export interface RootInvoker {
  invoke(request: RootRequest): Promise<RootResult>;
}

/** Immutable producer identity recorded in every public workpad entry. */
export const failureReportWorkpadProducerSchema = z
  .object({
    id: identifierSchema,
    github_actor_id: z.string().regex(/^\d+$/),
  })
  .strict();

/** Versioned metadata paired with one round-trippable public report snapshot. */
export const failureReportWorkpadEntryEnvelopeSchema = z
  .object({
    schema_version: z.literal("failure-report-workpad-entry/v2"),
    producer: failureReportWorkpadProducerSchema,
    logical_session_id: identifierSchema,
    entry_id: identifierSchema,
    revision: z.number().int().nonnegative(),
    predecessor_comment_ref: z.string().min(1).optional(),
    continuation_kind: z.enum(["capacity", "producer_transition"]).optional(),
  })
  .strict();

/** Complete immutable entry persisted in a FailureReport-managed comment. */
export type FailureReportWorkpadEntry = z.infer<
  typeof failureReportWorkpadEntryEnvelopeSchema
> & {
  report: FailureReport;
};

/** Decoded entries from one managed workpad comment, ordered by rendered history. */
export type FailureReportWorkpad = {
  entries: FailureReportWorkpadEntry[];
};

const failureReportWorkpadPayloadSchema = z
  .object({
    entry: failureReportWorkpadEntryEnvelopeSchema,
    failure_report: failureReportSchema,
  })
  .strict();

const sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * Provider-transport envelope for one immutable slice of a canonical entry.
 *
 * This schema is deliberately not referenced by RootRequest or FailureReport:
 * physical comment layout remains private to the GitHub provider boundary.
 */
export const failureReportWorkpadChunkEnvelopeSchema = z
  .object({
    schema_version: z.literal("failure-report-workpad-chunk/v1"),
    producer: failureReportWorkpadProducerSchema,
    logical_session_id: identifierSchema,
    entry_id: identifierSchema,
    revision: z.number().int().nonnegative(),
    group_id: identifierSchema,
    chunk_index: z.number().int().nonnegative(),
    chunk_count: z.number().int().positive(),
    chunk_digest: sha256DigestSchema,
    payload_digest: sha256DigestSchema,
    content_base64: z
      .string()
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  })
  .strict();

export type FailureReportWorkpadChunk = z.infer<
  typeof failureReportWorkpadChunkEnvelopeSchema
>;

const failureReportWorkpadManifestChunkSchema = z
  .object({
    comment_ref: z.string().min(1),
    chunk_index: z.number().int().nonnegative(),
    chunk_digest: sha256DigestSchema,
  })
  .strict();

/** Final authoritative commit record for one provider-bounded chunk group. */
export const failureReportWorkpadManifestEnvelopeSchema = z
  .object({
    schema_version: z.literal("failure-report-workpad-manifest/v1"),
    producer: failureReportWorkpadProducerSchema,
    logical_session_id: identifierSchema,
    entry_id: identifierSchema,
    revision: z.number().int().nonnegative(),
    group_id: identifierSchema,
    payload_digest: sha256DigestSchema,
    predecessor_comment_ref: z.string().min(1).optional(),
    continuation_kind: z.enum(["capacity", "producer_transition"]).optional(),
    chunks: z.array(failureReportWorkpadManifestChunkSchema).min(1),
  })
  .strict();

export type FailureReportWorkpadManifest = z.infer<
  typeof failureReportWorkpadManifestEnvelopeSchema
>;

/** Fully rendered provisional group plus the entry it losslessly encodes. */
export type FailureReportWorkpadChunkGroup = {
  group_id: string;
  payload_digest: string;
  entry: FailureReportWorkpadEntry;
  chunks: FailureReportWorkpadChunk[];
  chunk_comment_bodies: string[];
};

/**
 * Renders one managed comment containing its first immutable entry. Later entries
 * must be appended with `appendFailureReportWorkpadEntry` so rendered history is
 * never regenerated or rewritten.
 */
export function renderFailureReportWorkpad(
  entry: FailureReportWorkpadEntry,
): string {
  return [workpadMarker, renderFailureReportWorkpadEntry(entry), ""].join("\n");
}

/**
 * Appends one entry without changing any byte already present in the comment.
 * GitHub's update API still replaces the transport body, but the logical entries
 * that existed before this call remain an untouched prefix of the new body.
 */
export function appendFailureReportWorkpadEntry(
  existingMarkdown: string,
  entry: FailureReportWorkpadEntry,
): string {
  parseFailureReportWorkpad(existingMarkdown);
  return (
    existingMarkdown +
    (existingMarkdown.endsWith("\n") ? "\n" : "\n\n") +
    renderFailureReportWorkpadEntry(entry) +
    "\n"
  );
}

/** Renders the human summary before the folded canonical JSON payload. */
export function renderFailureReportWorkpadEntry(
  entry: FailureReportWorkpadEntry,
): string {
  const payload = failureReportWorkpadPayloadSchema.parse({
    entry: withoutReport(entry),
    failure_report: entry.report,
  });
  assertPublicWorkpadPayload(payload.failure_report);

  return [
    workpadEntryStartMarker,
    renderWorkpadHumanView(
      { ...payload.entry, report: payload.failure_report },
      { kind: "inline" },
    ),
    "",
    "<details>",
    "<summary>Canonical context — complete FailureReport snapshot</summary>",
    "",
    "~~~json",
    JSON.stringify(payload, null, 2),
    "~~~",
    "</details>",
    workpadEntryEndMarker,
  ].join("\n");
}

/**
 * Public pure renderer for the human view shared by inline and manifest workpads.
 *
 * The entry is parsed through the same canonical schemas and public-content
 * guard used by persistence before any report-authored text is projected.
 */
export function renderFailureReportWorkpadHumanView(
  entry: FailureReportWorkpadEntry,
  authority: FailureReportWorkpadAuthority = { kind: "inline" },
): string {
  const payload = failureReportWorkpadPayloadSchema.parse({
    entry: withoutReport(entry),
    failure_report: entry.report,
  });
  assertPublicWorkpadPayload(payload.failure_report);
  const parsedAuthority = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("inline") }).strict(),
      z
        .object({
          kind: z.literal("manifest"),
          group_id: identifierSchema,
          payload_digest: sha256DigestSchema,
          chunk_count: z.number().int().positive(),
        })
        .strict(),
    ])
    .parse(authority);
  return renderWorkpadHumanView(
    { ...payload.entry, report: payload.failure_report },
    parsedAuthority,
  );
}

/**
 * Parses every immutable entry before a comment can become runtime state.
 * Marker-only v1 comments intentionally fail here: they have no producer or
 * lineage proof and must be resolved through `needs_input` instead of migrated.
 */
export function parseFailureReportWorkpad(
  markdown: string,
): FailureReportWorkpad {
  if (countStandaloneMarkers(markdown, workpadMarker) !== 1) {
    throw new Error("Missing FailureReport workpad marker.");
  }
  if (
    markdown.includes(workpadManifestStartMarker) ||
    markdown.includes(workpadChunkMarker)
  ) {
    throw new Error(
      "FailureReport entry comment mixes incompatible transport representations.",
    );
  }

  const entries: FailureReportWorkpadEntry[] = [];
  const startMarkers = countStandaloneMarkers(
    markdown,
    workpadEntryStartMarker,
  );
  const endMarkers = countStandaloneMarkers(markdown, workpadEntryEndMarker);
  if (startMarkers !== endMarkers) {
    throw new Error("FailureReport workpad has an unclosed or stray v2 entry.");
  }
  if (markdown.includes("<!-- failure-report/v1 ")) {
    throw new Error(
      "FailureReport workpad contains a legacy v1 payload and requires input.",
    );
  }
  const entryPattern = new RegExp(
    "(?:^|\\r?\\n)[ \\t]*" +
      escapeRegExp(workpadEntryStartMarker) +
      "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*" +
      escapeRegExp(workpadEntryEndMarker) +
      "[ \\t]*(?=\\r?\\n|$)",
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(markdown))) {
    const body = match[1];
    if (!body) {
      throw new Error("FailureReport workpad entry is empty.");
    }
    const summary = body.indexOf("### FailureReport update");
    const details = body.indexOf("<details>");
    // Accept the #32 fold while reading append-only history; new entries use
    // the standalone #33 human view before their canonical context.
    const hasCanonicalSummary =
      body.includes(
        "<summary>Canonical context — complete FailureReport snapshot</summary>",
      ) || body.includes("<summary>Canonical FailureReport snapshot</summary>");
    if (
      summary === -1 ||
      details === -1 ||
      summary > details ||
      !hasCanonicalSummary ||
      !body.includes("</details>")
    ) {
      throw new Error(
        "FailureReport workpad entry is missing its required public summary or folded snapshot.",
      );
    }
    const payload = extractStandaloneJsonFence(body);
    if (!payload) {
      throw new Error(
        "FailureReport workpad entry is missing its JSON snapshot.",
      );
    }
    entries.push(parseFailureReportWorkpadPayload(payload));
  }

  if (entries.length === 0) {
    throw new Error(
      "FailureReport workpad has no schema-valid v2 entry; legacy or copied markers require input.",
    );
  }
  if (entries.length !== startMarkers) {
    throw new Error("FailureReport workpad has an unparsable v2 entry.");
  }
  return { entries };
}

/** Returns the exact canonical JSON bytes used by a multi-comment transaction. */
export function serializeFailureReportWorkpadEntryPayload(
  entry: FailureReportWorkpadEntry,
): string {
  const payload = failureReportWorkpadPayloadSchema.parse({
    entry: withoutReport(entry),
    failure_report: entry.report,
  });
  assertPublicWorkpadPayload(payload.failure_report);
  return JSON.stringify(payload);
}

/**
 * Splits one schema-valid canonical payload into immutable content-addressed
 * envelopes. The caller chooses only a raw-byte slice size; provider request
 * sizing remains outside the public FailureReport schema.
 */
export function createFailureReportWorkpadChunkGroup(
  entry: FailureReportWorkpadEntry,
  chunkByteLength: number,
  attempt = 0,
): FailureReportWorkpadChunkGroup {
  if (!Number.isSafeInteger(chunkByteLength) || chunkByteLength < 1) {
    throw new Error(
      "FailureReport chunk byte length must be a positive integer.",
    );
  }
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error("FailureReport chunk-group attempt must be nonnegative.");
  }

  const canonicalPayload = serializeFailureReportWorkpadEntryPayload(entry);
  const payloadBytes = Buffer.from(canonicalPayload, "utf8");
  const payloadDigest = digestBytes(payloadBytes);
  const slices: Buffer[] = [];
  for (
    let offset = 0;
    offset < payloadBytes.length;
    offset += chunkByteLength
  ) {
    slices.push(payloadBytes.subarray(offset, offset + chunkByteLength));
  }
  if (slices.length === 0) {
    throw new Error(
      "FailureReport canonical workpad payload is unexpectedly empty.",
    );
  }
  const chunkDigests = slices.map(digestBytes);
  const groupDigest = digestText(
    JSON.stringify({
      schema_version: "failure-report-workpad-group/v1",
      producer: entry.producer,
      logical_session_id: entry.logical_session_id,
      entry_id: entry.entry_id,
      revision: entry.revision,
      predecessor_comment_ref: entry.predecessor_comment_ref,
      continuation_kind: entry.continuation_kind,
      payload_digest: payloadDigest,
      chunk_digests: chunkDigests,
      attempt,
    }),
  );
  const groupId =
    "workpad-group/" +
    groupDigest.slice("sha256:".length) +
    "/attempt-" +
    String(attempt).padStart(10, "0");
  const chunks = slices.map((slice, chunkIndex) =>
    failureReportWorkpadChunkEnvelopeSchema.parse({
      schema_version: "failure-report-workpad-chunk/v1",
      producer: entry.producer,
      logical_session_id: entry.logical_session_id,
      entry_id: entry.entry_id,
      revision: entry.revision,
      group_id: groupId,
      chunk_index: chunkIndex,
      chunk_count: slices.length,
      chunk_digest: chunkDigests[chunkIndex],
      payload_digest: payloadDigest,
      content_base64: slice.toString("base64"),
    }),
  );
  return {
    group_id: groupId,
    payload_digest: payloadDigest,
    entry,
    chunks,
    chunk_comment_bodies: chunks.map(renderFailureReportWorkpadChunk),
  };
}

/** Renders a provisional chunk as folded, explicitly non-authoritative data. */
export function renderFailureReportWorkpadChunk(
  input: FailureReportWorkpadChunk,
): string {
  const chunk = failureReportWorkpadChunkEnvelopeSchema.parse(input);
  const bytes = decodeCanonicalBase64(chunk.content_base64);
  if (digestBytes(bytes) !== chunk.chunk_digest) {
    throw new Error(
      "FailureReport provisional chunk digest does not match its content.",
    );
  }
  if (chunk.chunk_index >= chunk.chunk_count) {
    throw new Error(
      "FailureReport provisional chunk index exceeds its declared count.",
    );
  }
  return [
    workpadChunkMarker,
    "> **Provisional FailureReport transport chunk — non-authoritative until referenced by a verified final manifest.**",
    "",
    "<details>",
    "<summary>Folded provisional chunk " +
      String(chunk.chunk_index + 1) +
      " of " +
      String(chunk.chunk_count) +
      "</summary>",
    "",
    "~~~json",
    JSON.stringify(chunk),
    "~~~",
    "</details>",
    "",
  ].join("\n");
}

/** Parses one provisional chunk without making it authoritative runtime state. */
export function parseFailureReportWorkpadChunk(
  markdown: string,
): FailureReportWorkpadChunk {
  if (!markdown.includes(workpadChunkMarker)) {
    throw new Error("Missing FailureReport provisional chunk marker.");
  }
  if (countOccurrences(markdown, workpadChunkMarker) !== 1) {
    throw new Error(
      "FailureReport provisional comment has duplicated chunk markers.",
    );
  }
  if (
    markdown.includes(workpadMarker) ||
    markdown.includes(workpadManifestStartMarker) ||
    markdown.includes(workpadEntryStartMarker)
  ) {
    throw new Error(
      "FailureReport provisional comment mixes incompatible transport representations.",
    );
  }
  const payload = extractStandaloneJsonFence(markdown);
  if (!payload) {
    throw new Error(
      "FailureReport provisional chunk is missing its JSON envelope.",
    );
  }
  const chunk = failureReportWorkpadChunkEnvelopeSchema.parse(
    JSON.parse(payload),
  );
  const bytes = decodeCanonicalBase64(chunk.content_base64);
  if (
    digestBytes(bytes) !== chunk.chunk_digest ||
    chunk.chunk_index >= chunk.chunk_count
  ) {
    throw new Error(
      "FailureReport provisional chunk has invalid ordering or content digest.",
    );
  }
  return chunk;
}

/** Builds the final visibility-boundary record after GitHub assigns chunk IDs. */
export function renderFailureReportWorkpadManifest(
  group: FailureReportWorkpadChunkGroup,
  commentRefs: readonly string[],
): string {
  if (commentRefs.length !== group.chunks.length) {
    throw new Error(
      "FailureReport manifest must reference every provisional chunk.",
    );
  }
  const manifest = failureReportWorkpadManifestEnvelopeSchema.parse({
    schema_version: "failure-report-workpad-manifest/v1",
    producer: group.entry.producer,
    logical_session_id: group.entry.logical_session_id,
    entry_id: group.entry.entry_id,
    revision: group.entry.revision,
    group_id: group.group_id,
    payload_digest: group.payload_digest,
    ...(group.entry.predecessor_comment_ref
      ? { predecessor_comment_ref: group.entry.predecessor_comment_ref }
      : {}),
    ...(group.entry.continuation_kind
      ? { continuation_kind: group.entry.continuation_kind }
      : {}),
    chunks: group.chunks.map((chunk, index) => ({
      comment_ref: commentRefs[index],
      chunk_index: chunk.chunk_index,
      chunk_digest: chunk.chunk_digest,
    })),
  });
  assertManifestOrdering(manifest);
  return [
    workpadMarker,
    workpadManifestStartMarker,
    renderFailureReportWorkpadHumanView(group.entry, {
      kind: "manifest",
      group_id: manifest.group_id,
      payload_digest: manifest.payload_digest,
      chunk_count: manifest.chunks.length,
    }),
    "",
    "<details>",
    "<summary>Canonical context — verified multi-comment manifest</summary>",
    "",
    "Reconstruction: concatenate the referenced chunks in `chunk_index` order, decode each canonical base64 payload as UTF-8, verify every chunk digest and the complete payload digest, then parse the `failure-report-workpad-entry/v2` payload.",
    "",
    "~~~json",
    JSON.stringify(manifest, null, 2),
    "~~~",
    "</details>",
    workpadManifestEndMarker,
    "",
  ].join("\n");
}

/** Parses a final manifest record without trusting or resolving its chunks. */
export function parseFailureReportWorkpadManifest(
  markdown: string,
): FailureReportWorkpadManifest {
  if (
    countOccurrences(markdown, workpadManifestStartMarker) !== 1 ||
    countOccurrences(markdown, workpadManifestEndMarker) !== 1 ||
    countStandaloneMarkers(markdown, workpadMarker) !== 1
  ) {
    throw new Error("FailureReport workpad manifest has invalid delimiters.");
  }
  const start = markdown.indexOf(workpadManifestStartMarker);
  const end = markdown.indexOf(workpadManifestEndMarker);
  if (!markdown.includes(workpadMarker) || start < 0 || end <= start) {
    throw new Error(
      "FailureReport workpad manifest is missing its managed marker.",
    );
  }
  if (
    markdown.includes(workpadEntryStartMarker) ||
    markdown.includes(workpadChunkMarker)
  ) {
    throw new Error(
      "FailureReport manifest mixes incompatible transport representations.",
    );
  }
  const body = markdown.slice(start, end);
  const hasCanonicalSummary =
    body.includes(
      "<summary>Canonical context — verified multi-comment manifest</summary>",
    ) ||
    body.includes("<summary>Canonical FailureReport chunk manifest</summary>");
  if (!body.includes("### FailureReport update") || !hasCanonicalSummary) {
    throw new Error(
      "FailureReport workpad manifest is missing its public summary.",
    );
  }
  const payload = extractStandaloneJsonFence(body);
  if (!payload) {
    throw new Error(
      "FailureReport workpad manifest is missing its JSON envelope.",
    );
  }
  const manifest = failureReportWorkpadManifestEnvelopeSchema.parse(
    JSON.parse(payload),
  );
  assertManifestOrdering(manifest);
  return manifest;
}

/**
 * Independently verifies every referenced chunk and only then parses the exact
 * reconstructed bytes through the canonical FailureReport payload schema.
 */
export function reconstructFailureReportWorkpadManifest(
  manifest: FailureReportWorkpadManifest,
  comments: readonly { comment_ref: string; body: string }[],
): FailureReportWorkpadEntry {
  const parsedManifest =
    failureReportWorkpadManifestEnvelopeSchema.parse(manifest);
  assertManifestOrdering(parsedManifest);
  const byRef = new Map<string, string>();
  for (const comment of comments) {
    if (byRef.has(comment.comment_ref)) {
      throw new Error(
        "FailureReport manifest reconstruction received a duplicated chunk comment.",
      );
    }
    byRef.set(comment.comment_ref, comment.body);
  }
  if (byRef.size !== parsedManifest.chunks.length) {
    throw new Error(
      "FailureReport manifest is missing or has extra referenced chunks.",
    );
  }

  const payloadParts = parsedManifest.chunks.map((reference) => {
    const body = byRef.get(reference.comment_ref);
    if (!body) {
      throw new Error(
        "FailureReport manifest references a missing provisional chunk.",
      );
    }
    const chunk = parseFailureReportWorkpadChunk(body);
    if (
      chunk.schema_version !== "failure-report-workpad-chunk/v1" ||
      chunk.producer.id !== parsedManifest.producer.id ||
      chunk.producer.github_actor_id !==
        parsedManifest.producer.github_actor_id ||
      chunk.logical_session_id !== parsedManifest.logical_session_id ||
      chunk.entry_id !== parsedManifest.entry_id ||
      chunk.revision !== parsedManifest.revision ||
      chunk.group_id !== parsedManifest.group_id ||
      chunk.payload_digest !== parsedManifest.payload_digest ||
      chunk.chunk_count !== parsedManifest.chunks.length ||
      chunk.chunk_index !== reference.chunk_index ||
      chunk.chunk_digest !== reference.chunk_digest
    ) {
      throw new Error(
        "FailureReport manifest references an incompatible provisional chunk.",
      );
    }
    return decodeCanonicalBase64(chunk.content_base64);
  });
  const payload = Buffer.concat(payloadParts);
  if (digestBytes(payload) !== parsedManifest.payload_digest) {
    throw new Error(
      "FailureReport reconstructed payload digest does not match its manifest.",
    );
  }
  const entry = parseFailureReportWorkpadPayload(payload.toString("utf8"));
  if (
    entry.producer.id !== parsedManifest.producer.id ||
    entry.producer.github_actor_id !==
      parsedManifest.producer.github_actor_id ||
    entry.logical_session_id !== parsedManifest.logical_session_id ||
    entry.entry_id !== parsedManifest.entry_id ||
    entry.revision !== parsedManifest.revision ||
    entry.predecessor_comment_ref !== parsedManifest.predecessor_comment_ref ||
    entry.continuation_kind !== parsedManifest.continuation_kind
  ) {
    throw new Error(
      "FailureReport manifest metadata does not match its canonical payload.",
    );
  }
  return entry;
}

function parseFailureReportWorkpadPayload(
  serialized: string,
): FailureReportWorkpadEntry {
  const parsed = failureReportWorkpadPayloadSchema.parse(
    JSON.parse(serialized),
  );
  const context = parsed.failure_report.shared_context;
  if (
    context?.workpad_revision !== parsed.entry.revision ||
    context.workpad_entry_id !== parsed.entry.entry_id ||
    context.workpad_logical_session_id !== parsed.entry.logical_session_id ||
    context.workpad_producer_id !== parsed.entry.producer.id ||
    context.workpad_predecessor_comment_ref !==
      parsed.entry.predecessor_comment_ref
  ) {
    throw new Error(
      "FailureReport workpad entry metadata does not match shared context.",
    );
  }
  assertPublicWorkpadPayload(parsed.failure_report);
  return { ...parsed.entry, report: parsed.failure_report };
}

function assertManifestOrdering(manifest: FailureReportWorkpadManifest): void {
  const refs = new Set<string>();
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (chunk.chunk_index !== index || refs.has(chunk.comment_ref)) {
      throw new Error(
        "FailureReport manifest chunk references must be unique and contiguous.",
      );
    }
    refs.add(chunk.comment_ref);
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(
      "FailureReport provisional chunk uses non-canonical base64.",
    );
  }
  return decoded;
}

function digestBytes(value: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function digestText(value: string): string {
  return digestBytes(Buffer.from(value, "utf8"));
}

/** Drops the convenience `report` property before serializing the schema envelope. */
function withoutReport(
  entry: FailureReportWorkpadEntry,
): z.infer<typeof failureReportWorkpadEntryEnvelopeSchema> {
  const { report: _report, ...envelope } = entry;
  return envelope;
}

/** Escapes literal marker text before using it in the entry parser's regex. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(text: string, value: string): number {
  let count = 0;
  let index = text.indexOf(value);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(value, index + value.length);
  }
  return count;
}

function countStandaloneMarkers(text: string, value: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim() === value).length;
}

/** Extracts only renderer-owned standalone fences, never fence text in JSON strings. */
function extractStandaloneJsonFence(text: string): string | undefined {
  return text.match(
    /(?:^|\r?\n)[ \t]*~~~json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*~~~[ \t]*(?=\r?\n|$)/,
  )?.[1];
}

/**
 * Prevents credentials, host-local paths, or non-opaque private evidence from
 * entering the public JSON payload. Restricted evidence may be referenced only
 * through an opaque `protected://` handle; its contents stay outside GitHub.
 */
function assertPublicWorkpadPayload(report: FailureReport): void {
  const prohibitedPath =
    /(?:^|[\s"'`(])(?:\/Users\/|\/Volumes\/|\/home\/|[A-Za-z]:\\\\)/;
  const credential =
    /(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|(?:api[_-]?key|token|secret|password|credential)\s*[:=]|bearer\s+\S+|:\/\/[^/:\s]+:[^/@\s]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

  const inspect = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (prohibitedPath.test(value)) {
        throw new Error(
          "FailureReport workpad cannot publish a prohibited host path at " +
            path +
            ".",
        );
      }
      if (credential.test(value)) {
        throw new Error(
          "FailureReport workpad cannot publish credential-like content at " +
            path +
            ".",
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        inspect(item, path + "[" + String(index) + "]"),
      );
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        inspect(child, path + "." + key);
      }
    }
  };

  for (const input of report.inputs) {
    assertOpaquePrivateArtifact(input.artifact.ref, input.artifact.sensitivity);
  }
  for (const evidence of report.evidence) {
    for (const artifact of evidence.artifacts) {
      assertOpaquePrivateArtifact(artifact.ref, artifact.sensitivity);
    }
  }
  for (const completion of report.diagnostic_completions ?? []) {
    for (const evidence of [
      ...completion.outcome.evidence,
      ...completion.outcome.operation_evidence,
    ]) {
      for (const artifact of evidence.artifacts) {
        assertOpaquePrivateArtifact(artifact.ref, artifact.sensitivity);
      }
    }
  }
  inspect(report, "failure_report");
}

function assertOpaquePrivateArtifact(
  ref: string,
  sensitivity: "public" | "internal" | "restricted" | "secret",
): void {
  const opaqueReference =
    ref.startsWith("protected://") || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ref);
  if (sensitivity !== "public" && !opaqueReference) {
    throw new Error(
      "Non-public evidence must use an opaque protected:// or logical reference before public workpad rendering.",
    );
  }
  if (
    sensitivity === "public" &&
    !opaqueReference &&
    !/^(?!file:)[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(ref)
  ) {
    throw new Error(
      "Public evidence must use a public URL or logical reference before public workpad rendering.",
    );
  }
}
