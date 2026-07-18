import { getDefaultGithubIssueGateway } from "../integrations/github/gateway-factory.js";
import { findExistingWorkpad } from "../integrations/github/issue-workpad.js";
import {
  DomainExtensionRegistryError,
  getDomainExtensions,
} from "./domain-extensions.js";
import {
  DiagnosticSessionWorkpad,
  type DiagnosticSessionIssueGateway,
  type FinalizeDiagnosticSessionInput,
} from "./workpad.js";
import {
  DiagnosticSafetyError,
  DiagnosticWorktreeManager,
} from "./worktree.js";

/** Stable Root-controlled input for ending one already-prepared diagnosis. */
export type FinalizeDiagnosticSessionRequest = FinalizeDiagnosticSessionInput;

/** Root-safe result: it exposes the durable snapshot ref, never a local path. */
export type FinalizeDiagnosticSessionResult =
  | {
      status: "finalized";
      report_id: string;
      workpad_revision: number;
      diagnostic_branch: string;
      head_revision: string;
    }
  | {
      status: "needs_input";
      report_id: string;
      reason: string;
    };

/** Host-only dependencies for Root's explicit diagnostic finalization path. */
export type DiagnosticSessionFinalizerOptions = {
  backend_id: string;
  gateway?:
    DiagnosticSessionIssueGateway | Promise<DiagnosticSessionIssueGateway>;
  now?: () => string;
};

/**
 * Creates the only Root path that turns a clean active diagnosis into a durable
 * diagnostic-only branch. The extension set comes exclusively from the already
 * parsed workpad session, never from the model invoking this tool.
 */
export function createDiagnosticSessionFinalizer(
  options: DiagnosticSessionFinalizerOptions,
): (
  input: FinalizeDiagnosticSessionRequest,
) => Promise<FinalizeDiagnosticSessionResult> {
  return async (input) => {
    try {
      const gateway = await Promise.resolve(
        options.gateway ?? getDefaultGithubIssueGateway(),
      );
      const issue = await gateway.readIssue(
        input.repository,
        input.issue_number,
      );
      const existing = findExistingWorkpad(
        issue,
        gateway.getWorkpadProducerConfiguration(),
      );
      if (!existing || existing.report.id !== input.report_id) {
        throw new DiagnosticSafetyError(
          "Diagnostic finalization requires the matching Root-published FailureReport workpad.",
        );
      }
      const sharedContext = existing.report.shared_context;
      if (
        !sharedContext ||
        sharedContext.repository !== input.repository ||
        sharedContext.issue_number !== input.issue_number ||
        sharedContext.workpad_revision !== existing.revision
      ) {
        throw new DiagnosticSafetyError(
          "Diagnostic finalization requires a workpad consistently bound to the requested GitHub Issue.",
        );
      }
      const session = existing.report.diagnostic_session;
      if (!session) {
        throw new DiagnosticSafetyError(
          "Cannot finalize a diagnostic session that was never prepared.",
        );
      }

      // A persisted final state is idempotent even if a later extension package
      // is unavailable: no checkout or skill materialization is needed again.
      if (session.lifecycle === "finalized") {
        return finalizedResult(
          input.report_id,
          existing.revision,
          session.diagnostic_branch,
        );
      }

      const domainExtensions = getDomainExtensions(session.domain_extensions);
      const workpad = new DiagnosticSessionWorkpad({
        gateway,
        now: options.now,
        worktrees: new DiagnosticWorktreeManager({
          domainExtensions,
          backendId: options.backend_id,
        }),
      });
      const finalized = await workpad.finalize(input);
      return finalizedResult(
        input.report_id,
        finalized.workpad_revision,
        finalized.diagnostic_session.diagnostic_branch,
      );
    } catch (error) {
      if (
        error instanceof DiagnosticSafetyError ||
        error instanceof DomainExtensionRegistryError
      ) {
        return {
          status: "needs_input",
          report_id: input.report_id,
          reason: error.message,
        };
      }
      throw error;
    }
  };
}

/** Narrows schema-validated finalized state into the tool's safe response. */
function finalizedResult(
  reportId: string,
  workpadRevision: number,
  diagnosticBranch:
    | {
        name: string;
        head_revision: string;
      }
    | undefined,
): FinalizeDiagnosticSessionResult {
  if (!diagnosticBranch) {
    throw new Error(
      "Finalized diagnostic session is missing its diagnostic snapshot branch.",
    );
  }
  return {
    status: "finalized",
    report_id: reportId,
    workpad_revision: workpadRevision,
    diagnostic_branch: diagnosticBranch.name,
    head_revision: diagnosticBranch.head_revision,
  };
}
