import {
  failureReportSchema,
  type ExecutionState,
  type FailureReport,
} from "@failure-report/protocol";

import {
  type GithubIssueSnapshot,
  findExistingWorkpad,
} from "../../integrations/github/issue-workpad.js";
import {
  GithubCliIssueGateway,
  type PublishedSharedContext,
} from "../../integrations/github/github-cli.js";
import {
  renderCkbExecutionEnvelope,
  type CkbExecutionEnvelope,
} from "./ckb-envelope.js";
import {
  CkbWorktreeManager,
  type VerifiedCkbExecution,
} from "./ckb-worktree.js";

export type CkbIssueGateway = {
  readIssue(
    repository: string,
    issueNumber: number,
  ): Promise<GithubIssueSnapshot>;
  publishSharedContext(
    repository: string,
    issueNumber: number,
    report: FailureReport,
    syncedAt: string,
  ): Promise<PublishedSharedContext>;
};

export type CkbExecutionWorkpadOptions = {
  gateway?: CkbIssueGateway;
  worktrees?: CkbWorktreeManager;
  now?: () => string;
};

export type LoadedCkbExecution = {
  report: FailureReport;
  workpad_revision: number;
  execution: VerifiedCkbExecution;
};

export type PreparedCkbExecution = LoadedCkbExecution & {
  delegation_message: string;
};

export class CkbExecutionWorkpad {
  private readonly gateway: CkbIssueGateway;
  private readonly worktrees: CkbWorktreeManager;
  private readonly now: () => string;

  constructor(options: CkbExecutionWorkpadOptions = {}) {
    this.gateway = options.gateway ?? new GithubCliIssueGateway();
    this.worktrees = options.worktrees ?? new CkbWorktreeManager();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async prepare(
    envelope: Omit<CkbExecutionEnvelope, "workpad_revision">,
  ): Promise<PreparedCkbExecution> {
    const current = await this.readWorkpad(envelope);
    let report = current.report;
    let workpadRevision = current.revision;
    let execution: VerifiedCkbExecution;

    if (report.execution_state) {
      execution = await this.worktrees.restore(report, report.execution_state);
    } else {
      execution = await this.worktrees.allocate(report);
      const nextReport = failureReportSchema.parse({
        ...report,
        execution_state: execution.state,
      });
      const published = await this.gateway.publishSharedContext(
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

    const preparedEnvelope: CkbExecutionEnvelope = {
      ...envelope,
      workpad_revision: workpadRevision,
    };
    return {
      report,
      workpad_revision: workpadRevision,
      execution,
      delegation_message: renderCkbExecutionEnvelope(preparedEnvelope),
    };
  }

  async loadForExecution(
    envelope: CkbExecutionEnvelope,
  ): Promise<LoadedCkbExecution> {
    const current = await this.readWorkpad(envelope);
    if (current.revision < envelope.workpad_revision) {
      throw new Error(
        "CKB execution workpad is older than the Root-prepared delegation envelope.",
      );
    }
    const state = current.report.execution_state;
    if (!state) {
      throw new Error(
        "CKB execution is blocked because no isolated worktree was durably prepared.",
      );
    }
    const execution = await this.worktrees.restore(current.report, state);
    return {
      report: current.report,
      workpad_revision: current.revision,
      execution,
    };
  }

  async recordThread(
    envelope: CkbExecutionEnvelope,
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

  async recordCompletion(
    envelope: CkbExecutionEnvelope,
    threadId?: string,
  ): Promise<FailureReport> {
    const current = await this.readWorkpad(envelope);
    const state = current.report.execution_state;
    if (!state) {
      throw new Error(
        "Cannot record CKB completion without a prepared execution state.",
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

  private async publishExecutionState(
    current: LoadedCkbExecution,
    executionState: ExecutionState,
  ): Promise<FailureReport> {
    const nextReport = failureReportSchema.parse({
      ...current.report,
      execution_state: executionState,
    });
    const issue = current.report.shared_context;
    if (!issue) {
      throw new Error(
        "Cannot write CKB execution state without a GitHub Issue shared context.",
      );
    }
    const published = await this.gateway.publishSharedContext(
      issue.repository,
      issue.issue_number,
      nextReport,
      this.now(),
    );
    return published.report;
  }

  private async readWorkpad(
    envelope: Pick<
      CkbExecutionEnvelope,
      "repository" | "issue_number" | "report_id"
    >,
  ): Promise<{ report: FailureReport; revision: number }> {
    const issue = await this.gateway.readIssue(
      envelope.repository,
      envelope.issue_number,
    );
    const workpad = findExistingWorkpad(issue);
    if (!workpad) {
      throw new Error(
        "CKB execution requires a Root-published FailureReport workpad before allocation.",
      );
    }
    if (workpad.report.id !== envelope.report_id) {
      throw new Error(
        "CKB execution envelope report id does not match the durable Issue workpad.",
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
