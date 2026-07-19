import {
  diagnosticBranchSlugFor,
  failureReportSchema,
  type DiagnosticSession,
  type FailureReport,
} from "@failure-report/protocol";

export { diagnosticBranchSlugFor };

import { getDefaultGithubIssueGateway } from "../integrations/github/gateway-factory.js";
import type { GithubIssueGateway } from "../integrations/github/issue-gateway.js";
import { findExistingWorkpad } from "../integrations/github/issue-workpad.js";
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

/**
 * Coordinates workpad revisions with Root-owned diagnostic-worktree lifecycle.
 * Codex may create a thread, but only this Root-side component journals it.
 */
export class DiagnosticSessionWorkpad {
  private readonly gateway: Promise<DiagnosticSessionIssueGateway>;
  private readonly worktrees: DiagnosticWorktreeManager;
  private readonly now: () => string;

  constructor(options: DiagnosticSessionWorkpadOptions) {
    this.gateway = Promise.resolve(
      options.gateway ?? getDefaultGithubIssueGateway(),
    );
    this.worktrees = options.worktrees;
    this.now = options.now ?? (() => new Date().toISOString());
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
      diagnosticSession = await this.worktrees.restore(
        report,
        report.diagnostic_session,
      );
      const persisted = await this.persistLegacyDiagnosticBranchSlug(
        current,
        diagnosticSession,
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
    const diagnosticSession = await this.worktrees.restore(
      current.report,
      state,
    );
    return this.persistLegacyDiagnosticBranchSlug(current, diagnosticSession);
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
    const published = await this.publishDiagnosticSession(current, {
      ...state,
      codex_thread_id: threadId,
    });
    return published.report;
  }

  /** Captures the current HEAD and diagnostic timestamp after a Codex turn. */
  async recordCompletion(
    envelope: DiagnosticSessionEnvelope,
    threadId?: string,
  ): Promise<FailureReport> {
    const current = await this.readWorkpad(envelope);
    const state = current.report.diagnostic_session;
    if (!state) {
      throw new Error(
        "Cannot record diagnostic completion without a prepared diagnostic session.",
      );
    }
    const diagnosticSession = await this.worktrees.captureCurrent(
      current.report,
      state,
    );
    const nextState: DiagnosticSession = {
      ...diagnosticSession.state,
      ...(threadId ? { codex_thread_id: threadId } : {}),
      last_diagnosed_at: this.now(),
    };
    const published = await this.publishDiagnosticSession(
      {
        report: current.report,
        workpad_revision: current.revision,
        diagnostic_session: diagnosticSession,
      },
      nextState,
    );
    return published.report;
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

    const diagnosticSession = await this.worktrees.finalize(
      current.report,
      state,
      this.now(),
    );
    const published = await this.publishDiagnosticSession(
      {
        report: current.report,
        workpad_revision: current.revision,
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

  /**
   * Makes a narrowly recovered legacy slug durable before Root exposes the
   * active session again. A failed restore never causes this repair to write.
   */
  private async persistLegacyDiagnosticBranchSlug(
    current: {
      report: FailureReport;
      revision: number;
      diagnostic_branch_slug_migrated: boolean;
    },
    diagnosticSession: VerifiedDiagnosticWorktree,
  ): Promise<LoadedDiagnosticSession> {
    if (!current.diagnostic_branch_slug_migrated) {
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
        "Legacy diagnostic-session migration did not persist session state.",
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
    diagnostic_branch_slug_migrated: boolean;
  }> {
    const gateway = await this.gateway;
    const issue = await gateway.readIssue(
      envelope.repository,
      envelope.issue_number,
    );
    const workpad = findExistingWorkpad(issue);
    if (!workpad) {
      throw new Error(
        "Diagnosis requires a Root-published FailureReport workpad before allocation.",
      );
    }
    if (workpad.report.id !== envelope.report_id) {
      throw new Error(
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
      throw new Error(
        "The durable FailureReport workpad is not consistently bound to the requested GitHub Issue.",
      );
    }
    return {
      report: workpad.report,
      revision: workpad.revision,
      issue,
      diagnostic_branch_slug_migrated: workpad.diagnostic_branch_slug_migrated,
    };
  }
}
