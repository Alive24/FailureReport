import {
  failureReportSchema,
  type ExecutionState,
  type FailureReport,
} from "@failure-report/protocol";

import { findExistingWorkpad } from "../../integrations/github/issue-workpad.js";
import { getDefaultGithubIssueGateway } from "../../integrations/github/gateway-factory.js";
import type { GithubIssueGateway } from "../../integrations/github/issue-gateway.js";
import {
  renderExecutionEnvelope,
  type ExecutionEnvelope,
  type ExecutionPreparationEnvelope,
} from "./envelope.js";
import {
  ExecutionWorktreeManager,
  type VerifiedExecution,
} from "./worktree.js";

/**
 * Durable execution journal backed by the report's GitHub Issue workpad.
 *
 * This module is domain-agnostic: a domain pack supplies a configured worktree
 * manager, while Root retains the only approved path to publish shared context.
 */

/**
 * Root-owned Issue gateway used by execution persistence.
 * Re-exported under this name to keep execution callers independent of the
 * concrete Octokit or explicit `gh` fallback transport.
 */
export type ExecutionIssueGateway = GithubIssueGateway;

/** Dependencies for a generic execution journal. */
export type ExecutionWorkpadOptions = {
  worktrees: ExecutionWorktreeManager;
  gateway?: ExecutionIssueGateway | Promise<ExecutionIssueGateway>;
  now?: () => string;
};

/** A workpad snapshot together with verified execution state. */
export type LoadedExecution = {
  report: FailureReport;
  workpad_revision: number;
  execution: VerifiedExecution;
};

/** A verified execution plus the only delegation message a provider may use. */
export type PreparedExecution = LoadedExecution & {
  delegation_message: string;
};

/**
 * Coordinates workpad revisions with isolated-worktree lifecycle state.
 *
 * Provider session metadata is journaled here after Root has approved setup, but
 * the provider itself never receives a GitHub write capability.
 */
export class ExecutionWorkpad {
  private readonly gateway: Promise<ExecutionIssueGateway>;
  private readonly worktrees: ExecutionWorktreeManager;
  private readonly now: () => string;

  constructor(options: ExecutionWorkpadOptions) {
    // Use the Root process's lazy default so this generic layer follows the
    // configured Octokit gateway without learning its auth or transport details.
    this.gateway = Promise.resolve(
      options.gateway ?? getDefaultGithubIssueGateway(),
    );
    this.worktrees = options.worktrees;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Restores an existing execution or allocates and durably records a new one.
   * A delegation message is rendered only after the workpad revision is known.
   */
  async prepare(
    envelope: ExecutionPreparationEnvelope,
  ): Promise<PreparedExecution> {
    const current = await this.readWorkpad(envelope);
    let report = current.report;
    let workpadRevision = current.revision;
    let execution: VerifiedExecution;

    if (report.execution_state) {
      execution = await this.worktrees.restore(report, report.execution_state);
    } else {
      execution = await this.worktrees.allocate(report);
      // Persist isolation state before exposing a delegation message. A provider
      // must never start work in a worktree that Root cannot later verify.
      const nextReport = failureReportSchema.parse({
        ...report,
        execution_state: execution.state,
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
      execution = {
        ...execution,
        state: report.execution_state ?? execution.state,
      };
    }

    const preparedEnvelope: ExecutionEnvelope = {
      ...envelope,
      workpad_revision: workpadRevision,
    };
    return {
      report,
      workpad_revision: workpadRevision,
      execution,
      delegation_message: renderExecutionEnvelope(preparedEnvelope),
    };
  }

  /**
   * Rehydrates and validates the state a domain provider may use for execution.
   * Rejects a workpad older than the delegation so a stale Issue cannot resume it.
   */
  async loadForExecution(
    envelope: ExecutionEnvelope,
  ): Promise<LoadedExecution> {
    const current = await this.readWorkpad(envelope);
    if (current.revision < envelope.workpad_revision) {
      throw new Error(
        "Execution workpad is older than the Root-prepared delegation envelope.",
      );
    }
    const state = current.report.execution_state;
    if (!state) {
      throw new Error(
        "Execution is blocked because no isolated worktree was durably prepared.",
      );
    }
    const execution = await this.worktrees.restore(current.report, state);
    return {
      report: current.report,
      workpad_revision: current.revision,
      execution,
    };
  }

  /** Records a provider-created Codex thread id once it is durably available. */
  async recordThread(
    envelope: ExecutionEnvelope,
    threadId: string,
  ): Promise<FailureReport> {
    const current = await this.loadForExecution(envelope);
    const state = current.execution.state;
    if (state.codex_thread_id === threadId) {
      return current.report;
    }
    return this.publishExecutionState(current, {
      ...state,
      codex_thread_id: threadId,
    });
  }

  /**
   * Captures the execution's final HEAD and completion time after a provider turn.
   * The worktree manager permits HEAD movement here because the running execution,
   * unlike a resume, is expected to modify its assigned branch.
   */
  async recordCompletion(
    envelope: ExecutionEnvelope,
    threadId?: string,
  ): Promise<FailureReport> {
    const current = await this.readWorkpad(envelope);
    const state = current.report.execution_state;
    if (!state) {
      throw new Error(
        "Cannot record execution completion without a prepared execution state.",
      );
    }
    const execution = await this.worktrees.captureCurrent(
      current.report,
      state,
    );
    const nextState: ExecutionState = {
      ...execution.state,
      ...(threadId ? { codex_thread_id: threadId } : {}),
      last_execution_at: this.now(),
    };
    return this.publishExecutionState(
      {
        report: current.report,
        workpad_revision: current.revision,
        execution,
      },
      nextState,
    );
  }

  /** Publishes only validated execution state while retaining the existing report. */
  private async publishExecutionState(
    current: LoadedExecution,
    executionState: ExecutionState,
  ): Promise<FailureReport> {
    const nextReport = failureReportSchema.parse({
      ...current.report,
      execution_state: executionState,
    });
    const issue = current.report.shared_context;
    if (!issue) {
      throw new Error(
        "Cannot write execution state without a GitHub Issue shared context.",
      );
    }
    const gateway = await this.gateway;
    const published = await gateway.publishSharedContext(
      issue.repository,
      issue.issue_number,
      nextReport,
      this.now(),
    );
    return published.report;
  }

  /** Reads and cross-checks the one durable workpad against a delegation identity. */
  private async readWorkpad(
    envelope: Pick<
      ExecutionEnvelope,
      "repository" | "issue_number" | "report_id"
    >,
  ): Promise<{ report: FailureReport; revision: number }> {
    const gateway = await this.gateway;
    const issue = await gateway.readIssue(
      envelope.repository,
      envelope.issue_number,
    );
    const workpad = findExistingWorkpad(issue);
    if (!workpad) {
      throw new Error(
        "Execution requires a Root-published FailureReport workpad before allocation.",
      );
    }
    if (workpad.report.id !== envelope.report_id) {
      throw new Error(
        "Execution envelope report id does not match the durable Issue workpad.",
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
    return { report: workpad.report, revision: workpad.revision };
  }
}
