import { z } from "zod";

/**
 * Canonical runtime and persistence contract for FailureReport.
 *
 * Every transport parses untrusted input through these schemas before it reaches
 * Root, and the GitHub workpad uses the same schemas when it is rehydrated.
 */

/** Marker used to locate the one structured FailureReport workpad comment. */
export const workpadMarker = "<!-- failure-report-workpad -->";

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
 * Validates the GitHub Issue binding stored alongside a report.
 *
 * This deliberately carries only collaboration metadata; diagnostic session state lives
 * separately so a backend-specific resume token cannot become shared context.
 */
export const githubIssueContextSchema = z
  .object({
    provider: z.literal("github_issue"),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    issue_number: z.number().int().positive(),
    issue_url: z.string().min(1),
    workpad_marker: z.literal(workpadMarker),
    workpad_comment_ref: z.string().min(1).optional(),
    workpad_revision: z.number().int().nonnegative(),
    synced_at: timestampSchema.optional(),
  })
  .strict();

/** Validates the immutable identity and current revision of an isolated worktree. */
export const diagnosticWorktreeSchema = z
  .object({
    path: z.string().min(1),
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
  .min(1)
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
        todo_status: z.enum([
          "not_ready",
          "ready",
          "ready_with_assumptions",
          "published",
        ]),
        gate_decision: z.enum([
          "Ready",
          "Ready With Assumptions",
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
        remaining_assumptions: stringListSchema,
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
  .strict();

/** Operations exposed by the single public Root entry point. */
export const rootOperationSchema = z.enum([
  "start",
  "resume",
  "inspect",
  "render_handoff",
]);

/** Validates an adapter request before it is handed to Root. */
export const rootRequestSchema = z
  .object({
    request_id: identifierSchema,
    operation: rootOperationSchema,
    report: failureReportSchema.optional(),
    issue: githubIssueContextSchema.optional(),
    message: z.string().min(1).optional(),
  })
  .strict();

/** Validates the only result shape adapters are allowed to return to callers. */
export const rootResultSchema = z
  .object({
    request_id: identifierSchema,
    status: z.enum(["accepted", "completed", "needs_input", "failed"]),
    report: failureReportSchema.optional(),
    issue: githubIssueContextSchema.optional(),
    summary: z.string().min(1),
    handoff_markdown: z.string().optional(),
  })
  .strict();

/** Typed FailureReport value inferred from the durable schema. */
export type FailureReport = z.infer<typeof failureReportSchema>;
/** Typed GitHub Issue context inferred from the durable schema. */
export type GithubIssueContext = z.infer<typeof githubIssueContextSchema>;
/** Typed durable diagnostic-session state inferred from the durable schema. */
export type DiagnosticSession = z.infer<typeof diagnosticSessionSchema>;
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

/** Decoded contents of the single structured workpad comment. */
export type FailureReportWorkpad = {
  report: FailureReport;
  revision: number;
};

/**
 * Serializes a report as the canonical, machine-readable Issue workpad payload.
 *
 * The header redundantly carries report ID and revision so parsing can reject a
 * copied JSON block that was attached to the wrong Issue comment.
 */
export function renderFailureReportWorkpad(
  report: FailureReport,
  revision: number,
): string {
  return [
    workpadMarker,
    '<!-- failure-report/v1 report-id="' +
      report.id +
      '" revision="' +
      String(revision) +
      '" -->',
    "~~~json",
    JSON.stringify({ failure_report: report }, null, 2),
    "~~~",
    "",
  ].join("\n");
}

/**
 * Parses and validates a persisted workpad comment before it becomes runtime state.
 *
 * Parsing the marker, header, JSON fence, and schema separately makes corruption
 * failures explicit instead of leaking a partially trusted object downstream.
 */
export function parseFailureReportWorkpad(
  markdown: string,
): FailureReportWorkpad {
  if (!markdown.includes(workpadMarker)) {
    throw new Error("Missing FailureReport workpad marker.");
  }

  const header = markdown.match(
    /<!-- failure-report\/v1 report-id="([^"]+)" revision="(\d+)" -->/,
  );
  const payload = markdown.match(/~~~json\s*([\s\S]*?)\s*~~~/);

  if (!header || !payload) {
    throw new Error(
      "FailureReport workpad is missing a header or JSON payload.",
    );
  }

  const reportId = header[1];
  const revision = header[2];
  const jsonPayload = payload[1];

  if (!reportId || !revision || !jsonPayload) {
    throw new Error(
      "FailureReport workpad has an incomplete header or JSON payload.",
    );
  }

  const decoded: unknown = JSON.parse(jsonPayload);
  const parsed = z
    .object({ failure_report: failureReportSchema })
    .strict()
    .parse(decoded);

  if (parsed.failure_report.id !== reportId) {
    throw new Error("FailureReport workpad header does not match report id.");
  }

  return {
    report: parsed.failure_report,
    revision: Number(revision),
  };
}
