import {
  diagnosticBranchSlugFor,
  failureReportSchema,
  nativeApprovalTerminalEvidenceSchema,
  type DiagnosticCompletionRecord,
  type DiagnosticSession,
  type FailureReport,
  type NativeApprovalTerminalEvidence,
} from "@failure-report/protocol";

import type { NativeApprovalSessionBinding } from "../backends/native-approval-broker.js";
import { getDefaultGithubIssueGateway } from "../integrations/github/gateway-factory.js";
import {
  isRetryableWorkpadPublicationError,
  type GithubIssueGateway,
} from "../integrations/github/issue-gateway.js";
import {
  WorkpadNeedsInputError,
  findExistingWorkpad,
} from "../integrations/github/issue-workpad.js";
import {
  DiagnosticCompletionIntegrityError,
  createDiagnosticCompletionRecord,
  projectDiagnosticCompletion,
  sameDiagnosticCompletion,
  validateDiagnosticCompletionHistory,
  type DiagnosticCompletionInput,
} from "./completion.js";
import {
  renderDiagnosticSessionEnvelope,
  type DiagnosticSessionEnvelope,
  type DiagnosticSessionPreparationEnvelope,
} from "./envelope.js";
import {
  DiagnosticSafetyError,
  DiagnosticWorktreeManager,
  type VerifiedDiagnosticWorktree,
} from "./worktree.js";

export { diagnosticBranchSlugFor };

/**
 * Durable diagnostic-session journal backed by the report's GitHub Issue workpad.
 *
 * The workpad remains the source for session/worktree/snapshot/HEAD/thread state;
 * GitHub shared context stays separate collaboration metadata rather than a
 * transport for provider runtime state.
 */

/** Root-owned Issue gateway used by diagnostic-session persistence. */
export type DiagnosticSessionIssueGateway = GithubIssueGateway;

/** Dependencies for a generic Root-owned diagnostic-session journal. */
export type DiagnosticSessionWorkpadOptions = {
  worktrees: DiagnosticWorktreeManager;
  gateway?:
    DiagnosticSessionIssueGateway | Promise<DiagnosticSessionIssueGateway>;
  now?: () => string;
  /** Number of verified publication-race retries after the first attempt. */
  completion_retry_limit?: number;
};

/** A workpad snapshot together with verified diagnostic worktree state. */
export type LoadedDiagnosticSession = {
  report: FailureReport;
  workpad_revision: number;
  diagnostic_session: VerifiedDiagnosticWorktree;
};

/** A verified diagnostic session plus the only delegation message Codex may use. */
export type PreparedDiagnosticSession = LoadedDiagnosticSession & {
  delegation_message: string;
};

/** Identity accepted by Root's explicit diagnostic-session finalizer. */
export type FinalizeDiagnosticSessionInput = Pick<
  DiagnosticSessionEnvelope,
  "report_id" | "repository" | "issue_number"
>;

/** Durable finalized snapshot returned without exposing a local checkout path. */
export type FinalizedDiagnosticSession = {
  report: FailureReport;
  workpad_revision: number;
  diagnostic_session: DiagnosticSession;
};

/** Durable completion result Root can map directly to a recoverable outcome. */
export type DiagnosticCompletionReconciliationResult =
  | {
      status: "completed";
      report: FailureReport;
      workpad_revision: number;
      completion: DiagnosticCompletionRecord;
      idempotent: boolean;
      attempts: number;
    }
  | {
      status: "needs_input";
      report_id: string;
      reason: string;
      completion_id?: string;
      attempts: number;
    };

/** Durable result of recording sanitized native-approval terminal evidence. */
export type NativeApprovalTerminalPersistenceResult = {
  report: FailureReport;
  workpad_revision: number;
  evidence: NativeApprovalTerminalEvidence;
  idempotent: boolean;
};

/** Signals a legacy caller that Root could not durably reconcile a completion. */
export class DiagnosticCompletionNeedsInputError extends DiagnosticSafetyError {
  readonly outcome = "needs_input";

  constructor(message: string) {
    super(message);
    this.name = "DiagnosticCompletionNeedsInputError";
  }
}

/**
 * Coordinates workpad revisions with Root-owned diagnostic-worktree lifecycle.
 * Codex may create a thread, but only this Root-side component journals it.
 */
export class DiagnosticSessionWorkpad {
  private readonly gateway: Promise<DiagnosticSessionIssueGateway>;
  private readonly worktrees: DiagnosticWorktreeManager;
  private readonly now: () => string;
  private readonly completionRetryLimit: number;

  constructor(options: DiagnosticSessionWorkpadOptions) {
    this.gateway = Promise.resolve(
      options.gateway ?? getDefaultGithubIssueGateway(),
    );
    this.worktrees = options.worktrees;
    this.now = options.now ?? (() => new Date().toISOString());
    this.completionRetryLimit = options.completion_retry_limit ?? 2;
    if (
      !Number.isInteger(this.completionRetryLimit) ||
      this.completionRetryLimit < 0
    ) {
      throw new Error(
        "Diagnostic completion retry limit must be a non-negative integer.",
      );
    }
  }

  /**
   * Restores an existing session or allocates and durably records a new one.
   * Root only renders a delegation after a workpad revision and skill link exist.
   */
  async prepare(
    envelope: DiagnosticSessionPreparationEnvelope,
  ): Promise<PreparedDiagnosticSession> {
    this.worktrees.assertNativeSkillNames(envelope.native_skill_names);
    const current = await this.readWorkpad(envelope);
    let report = current.report;
    let workpadRevision = current.revision;
    let diagnosticSession: VerifiedDiagnosticWorktree;

    if (report.diagnostic_session) {
      if (report.diagnostic_session.lifecycle !== "active") {
        throw new DiagnosticSafetyError(
          "Diagnostic session is finalized; prepare a separate future workflow instead of resuming its diagnostic worktree.",
        );
      }
      const restored = await this.restoreOrRehydrateDiagnosticSession(
        report,
        report.diagnostic_session,
      );
      diagnosticSession = restored.diagnostic_session;
      const persisted = await this.persistRecoveredDiagnosticSession(
        current,
        diagnosticSession,
        restored.worktree_rehomed,
      );
      report = persisted.report;
      workpadRevision = persisted.workpad_revision;
      diagnosticSession = persisted.diagnostic_session;
    } else {
      diagnosticSession = await this.worktrees.allocate(
        report,
        diagnosticBranchSlugFor(current.issue.title),
      );
      // Persist state before exposing a delegation. Codex must never start in a
      // worktree that Root cannot validate and recover on the next invocation.
      const nextReport = failureReportSchema.parse({
        ...report,
        diagnostic_session: diagnosticSession.state,
      });
      const gateway = await this.gateway;
      const published = await gateway.publishSharedContext(
        envelope.repository,
        envelope.issue_number,
        nextReport,
        this.now(),
      );
      report = published.report;
      workpadRevision = published.workpad_revision;
      diagnosticSession = {
        ...diagnosticSession,
        state: report.diagnostic_session ?? diagnosticSession.state,
      };
    }

    const preparedEnvelope: DiagnosticSessionEnvelope = {
      ...envelope,
      workpad_revision: workpadRevision,
    };
    return {
      report,
      workpad_revision: workpadRevision,
      diagnostic_session: diagnosticSession,
      delegation_message: renderDiagnosticSessionEnvelope(preparedEnvelope),
    };
  }

  /**
   * Rehydrates and validates state a Codex worker may use. A workpad older than
   * the delegation is rejected so a stale Issue cannot resume a newer session.
   */
  async loadForDiagnosticSession(
    envelope: DiagnosticSessionEnvelope,
  ): Promise<LoadedDiagnosticSession> {
    this.worktrees.assertNativeSkillNames(envelope.native_skill_names);
    const current = await this.readWorkpad(envelope);
    if (current.revision < envelope.workpad_revision) {
      throw new Error(
        "Diagnostic-session workpad is older than the Root-prepared delegation envelope.",
      );
    }
    const state = current.report.diagnostic_session;
    if (!state) {
      throw new Error(
        "Diagnosis is blocked because no diagnostic worktree was durably prepared.",
      );
    }
    const restored = await this.restoreOrRehydrateDiagnosticSession(
      current.report,
      state,
    );
    return this.persistRecoveredDiagnosticSession(
      current,
      restored.diagnostic_session,
      restored.worktree_rehomed,
    );
  }

  /** Records a Codex App Server thread id once Root observes it. */
  async recordThread(
    envelope: DiagnosticSessionEnvelope,
    threadId: string,
  ): Promise<FailureReport> {
    const current = await this.loadForDiagnosticSession(envelope);
    const state = current.diagnostic_session.state;
    if (state.codex_thread_id === threadId) {
      return current.report;
    }
    if (state.codex_thread_id && state.codex_thread_id !== threadId) {
      throw new DiagnosticSafetyError(
        "Codex App Server attempted to replace the persisted diagnostic thread; explicit operator input is required.",
      );
    }
    const published = await this.publishDiagnosticSession(current, {
      ...state,
      codex_thread_id: threadId,
    });
    return published.report;
  }

  /**
   * Derives the only broker binding from a workpad-validated, Root-managed
   * worktree. The live broker receives no local path and no write authority.
   */
  async loadNativeApprovalSessionBinding(
    envelope: DiagnosticSessionEnvelope,
  ): Promise<NativeApprovalSessionBinding> {
    const current = await this.loadForDiagnosticSession(envelope);
    return this.nativeApprovalSessionBinding(envelope, current);
  }

  /**
   * Appends one sanitized terminal approval fact after revalidating the active
   * diagnostic session. Provider request ids and approval payloads are absent
   * by type, so they cannot become workpad state through this boundary.
   */
  async recordNativeApprovalTerminal(
    envelope: DiagnosticSessionEnvelope,
    binding: NativeApprovalSessionBinding,
    evidence: NativeApprovalTerminalEvidence,
  ): Promise<NativeApprovalTerminalPersistenceResult> {
    const current = await this.loadForDiagnosticSession(envelope);
    this.assertNativeApprovalBinding(envelope, current, binding);
    const terminal = nativeApprovalTerminalEvidenceSchema.parse(evidence);
    if (
      terminal.backend_id !== binding.backend_id ||
      terminal.diagnostic_session_identity !==
        binding.diagnostic_session_identity
    ) {
      throw new DiagnosticSafetyError(
        "Native approval terminal evidence does not match the active diagnostic session.",
      );
    }

    const state = current.diagnostic_session.state;
    const existing = state.native_approval_evidence?.find(
      (candidate) => candidate.approval_id === terminal.approval_id,
    );
    if (existing) {
      if (!sameNativeApprovalTerminal(existing, terminal)) {
        throw new DiagnosticSafetyError(
          "Native approval terminal evidence repeats an id with incompatible content.",
        );
      }
      return {
        report: current.report,
        workpad_revision: current.workpad_revision,
        evidence: existing,
        idempotent: true,
      };
    }

    const published = await this.publishDiagnosticSession(current, {
      ...state,
      native_approval_evidence: [
        ...(state.native_approval_evidence ?? []),
        terminal,
      ],
    });
    const persisted =
      published.report.diagnostic_session?.native_approval_evidence?.find(
        (candidate) => candidate.approval_id === terminal.approval_id,
      );
    if (!persisted || !sameNativeApprovalTerminal(persisted, terminal)) {
      throw new DiagnosticSafetyError(
        "Native approval terminal evidence post-write readback did not contain the expected record.",
      );
    }
    return {
      report: published.report,
      workpad_revision: published.workpad_revision,
      evidence: persisted,
      idempotent: false,
    };
  }

  /**
   * Root-owned read-merge-write-readback transaction for one completed Codex
   * turn. It captures one observed worktree HEAD, then reloads the logical
   * workpad before every bounded publication attempt. Codex supplies only its
   * thread and evidence outcome; it never receives a GitHub mutation path.
   */
  async reconcileCompletion(
    envelope: DiagnosticSessionEnvelope,
    completion: DiagnosticCompletionInput,
  ): Promise<DiagnosticCompletionReconciliationResult> {
    let captured:
      | {
          diagnostic_session: VerifiedDiagnosticWorktree;
          target_revision: string;
          diagnostic_session_identity: string;
          observed_worktree_head: string;
          completed_at: string;
        }
      | undefined;
    let completionId: string | undefined;
    const maxAttempts = this.completionRetryLimit + 1;

    for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
      try {
        const current = await this.readWorkpad(envelope);
        const currentSession = current.report.diagnostic_session;
        if (!currentSession) {
          return this.completionNeedsInput(
            envelope.report_id,
            "Cannot reconcile diagnostic completion without a prepared diagnostic session.",
            attempts,
          );
        }
        if (currentSession.lifecycle !== "active") {
          return this.completionNeedsInput(
            envelope.report_id,
            "Cannot reconcile a completion into a finalized diagnostic session.",
            attempts,
          );
        }
        if (!completion.codex_thread_id) {
          return this.completionNeedsInput(
            envelope.report_id,
            "Diagnostic completion requires the persisted Codex thread identity.",
            attempts,
          );
        }

        if (!captured) {
          const observed = await this.worktrees.captureCurrent(
            current.report,
            currentSession,
          );
          captured = {
            diagnostic_session: observed,
            target_revision: current.report.target.revision,
            diagnostic_session_identity: observed.state.worktree.identity,
            observed_worktree_head: observed.state.worktree.head_revision,
            completed_at: this.now(),
          };
        }

        const stateProblem = validateCompletionReconciliationState({
          report: current.report,
          diagnostic_session: currentSession,
          captured,
          completion,
        });
        if (stateProblem) {
          return this.completionNeedsInput(
            envelope.report_id,
            stateProblem,
            attempts,
            completionId,
          );
        }

        const candidate = createDiagnosticCompletionRecord({
          report: current.report,
          diagnostic_session: captured.diagnostic_session.state,
          observed_worktree_head: captured.observed_worktree_head,
          completion,
          completed_at: captured.completed_at,
        });
        completionId = candidate.completion_id;
        const existing = current.report.diagnostic_completions?.find(
          (record) => record.completion_id === candidate.completion_id,
        );
        if (existing) {
          // The first successful write owns its timestamp. A provider replay
          // must compare against that immutable record rather than mint a new
          // completion just because the local clock advanced. A bare provider
          // finish has no report payload, so Root uses the already durable
          // outcome only when the replay omitted one; an explicit divergent
          // payload still fails closed below.
          const replayInput: DiagnosticCompletionInput = {
            ...completion,
            ...(completion.outcome === undefined
              ? { outcome: existing.outcome }
              : {}),
            ...(completion.provider_finish_reason === undefined &&
            existing.metadata.provider_finish_reason
              ? {
                  provider_finish_reason:
                    existing.metadata.provider_finish_reason,
                }
              : {}),
          };
          const replay = createDiagnosticCompletionRecord({
            report: current.report,
            diagnostic_session: captured.diagnostic_session.state,
            observed_worktree_head: captured.observed_worktree_head,
            completion: replayInput,
            completed_at: existing.metadata.completed_at,
          });
          if (!sameDiagnosticCompletion(existing, replay)) {
            return this.completionNeedsInput(
              envelope.report_id,
              "A duplicate diagnostic completion identity carries incompatible content.",
              attempts,
              completionId,
            );
          }
          return {
            status: "completed",
            report: current.report,
            workpad_revision: current.revision,
            completion: existing,
            idempotent: true,
            attempts,
          };
        }

        if (
          currentSession.worktree.head_revision !==
            captured.observed_worktree_head &&
          (currentSession.last_diagnosed_at ||
            currentSession.worktree.head_revision !==
              current.report.target.revision ||
            (current.report.diagnostic_completions?.length ?? 0) > 0)
        ) {
          return this.completionNeedsInput(
            envelope.report_id,
            "A newer diagnostic completion has already advanced the persisted worktree HEAD; refusing to regress it.",
            attempts,
            completionId,
          );
        }

        const nextSession: DiagnosticSession = {
          ...currentSession,
          worktree: {
            ...currentSession.worktree,
            head_revision: captured.observed_worktree_head,
          },
          last_diagnosed_at: candidate.metadata.completed_at,
        };
        const projected = projectDiagnosticCompletion({
          report: current.report,
          diagnostic_session: nextSession,
          completion: candidate,
        });
        if (projected.status === "needs_input") {
          return this.completionNeedsInput(
            envelope.report_id,
            projected.reason,
            attempts,
            completionId,
          );
        }

        const issue = current.report.shared_context;
        if (!issue) {
          return this.completionNeedsInput(
            envelope.report_id,
            "Cannot reconcile diagnostic completion without a GitHub Issue shared context.",
            attempts,
            completionId,
          );
        }
        const gateway = await this.gateway;
        const published = await gateway.publishSharedContext(
          issue.repository,
          issue.issue_number,
          projected.report,
          this.now(),
        );
        const persistedProblem = validateDiagnosticCompletionHistory(
          published.report,
        );
        if (persistedProblem) {
          throw new DiagnosticCompletionIntegrityError(persistedProblem);
        }
        const persisted = published.report.diagnostic_completions?.find(
          (record) => record.completion_id === candidate.completion_id,
        );
        if (!persisted || !sameDiagnosticCompletion(persisted, candidate)) {
          throw new DiagnosticCompletionIntegrityError(
            "Diagnostic completion post-write readback did not contain the expected immutable record.",
          );
        }
        return {
          status: "completed",
          report: published.report,
          workpad_revision: published.workpad_revision,
          completion: persisted,
          idempotent: false,
          attempts,
        };
      } catch (error) {
        if (
          isRetryableWorkpadPublicationError(error) &&
          attempts < maxAttempts
        ) {
          continue;
        }
        if (isRetryableWorkpadPublicationError(error)) {
          return this.completionNeedsInput(
            envelope.report_id,
            "Diagnostic completion reconciliation exhausted its bounded publication-race retry budget: " +
              error.message,
            attempts,
            completionId,
          );
        }
        if (
          error instanceof WorkpadNeedsInputError ||
          error instanceof DiagnosticCompletionIntegrityError ||
          error instanceof DiagnosticSafetyError
        ) {
          return this.completionNeedsInput(
            envelope.report_id,
            error.message,
            attempts,
            completionId,
          );
        }
        throw error;
      }
    }

    return this.completionNeedsInput(
      envelope.report_id,
      "Diagnostic completion reconciliation reached an unreachable retry state.",
      maxAttempts,
      completionId,
    );
  }

  /**
   * Compatibility wrapper for the provider adapter. New Root code should use
   * `reconcileCompletion` so it can return a structured `needs_input` result.
   */
  async recordCompletion(
    envelope: DiagnosticSessionEnvelope,
    threadId?: string,
    outcome?: DiagnosticCompletionInput["outcome"],
    providerFinishReason?: string,
  ): Promise<FailureReport> {
    const reconciled = await this.reconcileCompletion(envelope, {
      codex_thread_id: threadId ?? "",
      ...(outcome ? { outcome } : {}),
      ...(providerFinishReason
        ? { provider_finish_reason: providerFinishReason }
        : {}),
    });
    if (reconciled.status === "needs_input") {
      throw new DiagnosticCompletionNeedsInputError(reconciled.reason);
    }
    return reconciled.report;
  }

  /**
   * Explicitly ends an active diagnostic session and journals its immutable
   * diagnostic-only branch. The worktree manager performs all Git validation;
   * this layer is the only one that writes the resulting state to GitHub.
   */
  async finalize(
    input: FinalizeDiagnosticSessionInput,
  ): Promise<FinalizedDiagnosticSession> {
    const current = await this.readWorkpad(input);
    const state = current.report.diagnostic_session;
    if (!state) {
      throw new DiagnosticSafetyError(
        "Cannot finalize a diagnostic session that was never prepared.",
      );
    }
    if (state.lifecycle === "finalized") {
      return {
        report: current.report,
        workpad_revision: current.revision,
        diagnostic_session: state,
      };
    }

    const restored = await this.restoreOrRehydrateDiagnosticSession(
      current.report,
      state,
    );
    const recovered = await this.persistRecoveredDiagnosticSession(
      current,
      restored.diagnostic_session,
      restored.worktree_rehomed,
    );
    const diagnosticSession = await this.worktrees.finalize(
      recovered.report,
      recovered.diagnostic_session.state,
      this.now(),
    );
    const published = await this.publishDiagnosticSession(
      {
        report: recovered.report,
        workpad_revision: recovered.workpad_revision,
        diagnostic_session: diagnosticSession,
      },
      diagnosticSession.state,
    );
    const finalized = published.report.diagnostic_session;
    if (!finalized || finalized.lifecycle !== "finalized") {
      throw new Error(
        "Diagnostic finalization did not persist finalized session state.",
      );
    }
    return {
      report: published.report,
      workpad_revision: published.workpad_revision,
      diagnostic_session: finalized,
    };
  }

  /** Publishes only validated diagnostic session state while retaining the report. */
  private async publishDiagnosticSession(
    current: LoadedDiagnosticSession,
    diagnosticSession: DiagnosticSession,
  ): Promise<{ report: FailureReport; workpad_revision: number }> {
    const nextReport = failureReportSchema.parse({
      ...current.report,
      diagnostic_session: diagnosticSession,
    });
    const issue = current.report.shared_context;
    if (!issue) {
      throw new Error(
        "Cannot write diagnostic session state without a GitHub Issue shared context.",
      );
    }
    const gateway = await this.gateway;
    const published = await gateway.publishSharedContext(
      issue.repository,
      issue.issue_number,
      nextReport,
      this.now(),
    );
    return {
      report: published.report,
      workpad_revision: published.workpad_revision,
    };
  }

  /** Derives a generic binding only after the current worktree was restored. */
  private nativeApprovalSessionBinding(
    envelope: DiagnosticSessionEnvelope,
    current: LoadedDiagnosticSession,
  ): NativeApprovalSessionBinding {
    const state = current.diagnostic_session.state;
    if (state.lifecycle !== "active") {
      throw new DiagnosticSafetyError(
        "Native approval requires an active diagnostic session.",
      );
    }
    if (!state.codex_thread_id) {
      throw new DiagnosticSafetyError(
        "Native approval requires the persisted diagnostic thread identity.",
      );
    }
    return {
      report_id: envelope.report_id,
      repository: envelope.repository,
      issue_number: envelope.issue_number,
      backend_id: state.backend_id,
      diagnostic_session_identity: state.worktree.identity,
      worktree_identity: current.diagnostic_session.state.worktree.identity,
      persistent_thread_id: state.codex_thread_id,
    };
  }

  /** Rejects a stale, mismatched, finalized, or threadless broker binding. */
  private assertNativeApprovalBinding(
    envelope: DiagnosticSessionEnvelope,
    current: LoadedDiagnosticSession,
    binding: NativeApprovalSessionBinding,
  ): void {
    const expected = this.nativeApprovalSessionBinding(envelope, current);
    if (
      binding.report_id !== expected.report_id ||
      binding.repository !== expected.repository ||
      binding.issue_number !== expected.issue_number ||
      binding.backend_id !== expected.backend_id ||
      binding.diagnostic_session_identity !==
        expected.diagnostic_session_identity ||
      binding.worktree_identity !== expected.worktree_identity ||
      binding.persistent_thread_id !== expected.persistent_thread_id
    ) {
      throw new DiagnosticSafetyError(
        "Native approval binding no longer matches the active Root-managed diagnostic session.",
      );
    }
  }

  /** Shapes all deterministic reconciliation conflicts for Root callers. */
  private completionNeedsInput(
    reportId: string,
    reason: string,
    attempts: number,
    completionId?: string,
  ): DiagnosticCompletionReconciliationResult {
    return {
      status: "needs_input",
      report_id: reportId,
      reason,
      attempts,
      ...(completionId ? { completion_id: completionId } : {}),
    };
  }

  /**
   * Rehydrates an old Root-runtime worktree only after normal restoration has
   * failed its safety checks. The manager permits only an unchanged immutable
   * target revision and never reuses the former runtime's directory.
   */
  private async restoreOrRehydrateDiagnosticSession(
    report: FailureReport,
    state: DiagnosticSession,
  ): Promise<{
    diagnostic_session: VerifiedDiagnosticWorktree;
    worktree_rehomed: boolean;
  }> {
    try {
      return {
        diagnostic_session: await this.worktrees.restore(report, state),
        worktree_rehomed: false,
      };
    } catch (error) {
      if (!(error instanceof DiagnosticSafetyError)) {
        throw error;
      }
      return {
        diagnostic_session: await this.worktrees.rehydrateLegacyRuntimeWorktree(
          report,
          state,
        ),
        worktree_rehomed: true,
      };
    }
  }

  /**
   * Persists all narrow legacy recovery before Root exposes the active session
   * or attempts finalization. A failed ordinary restore never reaches this write.
   */
  private async persistRecoveredDiagnosticSession(
    current: {
      report: FailureReport;
      revision: number;
    },
    diagnosticSession: VerifiedDiagnosticWorktree,
    worktreeRehomed: boolean,
  ): Promise<LoadedDiagnosticSession> {
    if (!worktreeRehomed) {
      return {
        report: current.report,
        workpad_revision: current.revision,
        diagnostic_session: diagnosticSession,
      };
    }

    const published = await this.publishDiagnosticSession(
      {
        report: current.report,
        workpad_revision: current.revision,
        diagnostic_session: diagnosticSession,
      },
      diagnosticSession.state,
    );
    const state = published.report.diagnostic_session;
    if (!state) {
      throw new Error(
        "Legacy diagnostic-session recovery did not persist session state.",
      );
    }
    return {
      report: published.report,
      workpad_revision: published.workpad_revision,
      diagnostic_session: {
        ...diagnosticSession,
        state,
      },
    };
  }

  /** Reads and cross-checks the one durable workpad against a session identity. */
  private async readWorkpad(
    envelope: Pick<
      DiagnosticSessionEnvelope,
      "repository" | "issue_number" | "report_id"
    >,
  ): Promise<{
    report: FailureReport;
    revision: number;
    issue: Awaited<ReturnType<DiagnosticSessionIssueGateway["readIssue"]>>;
  }> {
    const gateway = await this.gateway;
    const issue = await gateway.readIssue(
      envelope.repository,
      envelope.issue_number,
    );
    const workpad = findExistingWorkpad(
      issue,
      gateway.getWorkpadProducerConfiguration(),
    );
    if (!workpad) {
      throw new DiagnosticSafetyError(
        "Diagnosis requires a Root-published FailureReport workpad before allocation.",
      );
    }
    if (workpad.report.id !== envelope.report_id) {
      throw new DiagnosticSafetyError(
        "Diagnostic-session envelope report id does not match the durable Issue workpad.",
      );
    }
    const sharedContext = workpad.report.shared_context;
    if (
      !sharedContext ||
      sharedContext.repository !== envelope.repository ||
      sharedContext.issue_number !== envelope.issue_number ||
      sharedContext.workpad_revision !== workpad.revision
    ) {
      throw new DiagnosticSafetyError(
        "The durable FailureReport workpad is not consistently bound to the requested GitHub Issue.",
      );
    }
    return {
      report: workpad.report,
      revision: workpad.revision,
      issue,
    };
  }
}

/**
 * Verifies that a retry still refers to the one active session Root observed
 * before the first write. A newer report is mergeable only when these immutable
 * session, thread, and target bindings have not changed.
 */
function validateCompletionReconciliationState(input: {
  report: FailureReport;
  diagnostic_session: DiagnosticSession;
  captured: {
    diagnostic_session: VerifiedDiagnosticWorktree;
    target_revision: string;
    diagnostic_session_identity: string;
    observed_worktree_head: string;
    completed_at: string;
  };
  completion: DiagnosticCompletionInput;
}): string | undefined {
  const historyProblem = validateDiagnosticCompletionHistory(input.report);
  if (historyProblem) {
    return historyProblem;
  }
  if (input.report.target.revision !== input.captured.target_revision) {
    return "The durable report target revision changed during completion reconciliation.";
  }
  if (
    input.diagnostic_session.worktree.identity !==
    input.captured.diagnostic_session_identity
  ) {
    return "The active diagnostic session changed during completion reconciliation.";
  }
  if (
    input.diagnostic_session.worktree.base_revision !==
    input.report.target.revision
  ) {
    return "The active diagnostic session is no longer bound to the report's immutable target revision.";
  }
  if (
    input.diagnostic_session.backend_id !==
      input.captured.diagnostic_session.state.backend_id ||
    input.diagnostic_session.diagnostic_branch_slug !==
      input.captured.diagnostic_session.state.diagnostic_branch_slug ||
    input.diagnostic_session.domain_extensions.join("\u0000") !==
      input.captured.diagnostic_session.state.domain_extensions.join("\u0000")
  ) {
    return "The active diagnostic session invariants changed during completion reconciliation.";
  }
  if (
    input.diagnostic_session.codex_thread_id !==
    input.completion.codex_thread_id
  ) {
    return "Diagnostic completion Codex thread does not match the persisted active session.";
  }
  if (
    input.captured.diagnostic_session.state.codex_thread_id !==
    input.completion.codex_thread_id
  ) {
    return "The observed diagnostic worktree is not bound to the persisted Codex thread.";
  }
  return undefined;
}

/** Compares the fixed sanitized approval-evidence shape without provider data. */
function sameNativeApprovalTerminal(
  left: NativeApprovalTerminalEvidence,
  right: NativeApprovalTerminalEvidence,
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.approval_id === right.approval_id &&
    left.backend_id === right.backend_id &&
    left.diagnostic_session_identity === right.diagnostic_session_identity &&
    left.turn_id === right.turn_id &&
    left.status === right.status &&
    left.decision === right.decision &&
    left.reason === right.reason &&
    left.recorded_at === right.recorded_at
  );
}
