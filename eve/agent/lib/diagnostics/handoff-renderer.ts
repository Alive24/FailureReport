import {
  HandoffNeedsInputError,
  renderDiagnosticHandoff,
  type HumanInputRequest,
  type ImplementationHandoff,
} from "@failure-report/protocol";

import { getDefaultGithubIssueGateway } from "../integrations/github/gateway-factory.js";
import type { GithubIssueGateway } from "../integrations/github/issue-gateway.js";
import {
  WorkpadNeedsInputError,
  findExistingWorkpad,
  type ExistingWorkpad,
  type GithubIssueSnapshot,
} from "../integrations/github/issue-workpad.js";

/** Caller revision binding that prevents Root from rendering stale supplied state. */
export type RenderDiagnosticHandoffRequest = {
  report_id: string;
  repository: string;
  issue_number: number;
  expected_workpad_revision: number;
  expected_workpad_logical_session_id: string;
  expected_workpad_entry_id: string;
  expected_target_revision: string;
};

/** Read-only result consumed by Root when handling the public render operation. */
export type RenderDiagnosticHandoffResult =
  | {
      status: "completed";
      report_id: string;
      implementation_handoff: ImplementationHandoff;
    }
  | {
      status: "needs_input";
      report_id: string;
      human_input_request: HumanInputRequest;
    }
  | {
      status: "needs_input";
      report_id: string;
      reason: string;
    };

export type DiagnosticHandoffRendererOptions = {
  gateway?: GithubIssueGateway | Promise<GithubIssueGateway>;
};

/**
 * Creates Root's read-only handoff operation.
 *
 * It performs a fresh verified read, validates every caller revision binding,
 * renders from that durable head, then re-reads once to reject a concurrent
 * lineage change. It never invokes the gateway's publication surface.
 */
export function createDiagnosticHandoffRenderer(
  options: DiagnosticHandoffRendererOptions = {},
): (
  input: RenderDiagnosticHandoffRequest,
) => Promise<RenderDiagnosticHandoffResult> {
  return async (input) => {
    try {
      const gateway = await Promise.resolve(
        options.gateway ?? getDefaultGithubIssueGateway(),
      );
      const first = await readVerifiedHead(gateway, input);
      assertCallerBinding(first.workpad, input);

      const rendered = renderDiagnosticHandoff(first.workpad.report);

      const second = await readVerifiedHead(gateway, input);
      if (workpadReadIdentity(first) !== workpadReadIdentity(second)) {
        throw new HandoffNeedsInputError(
          "Managed workpad changed concurrently while Root was rendering; reload the latest revision.",
        );
      }

      if (
        rendered.schema_version === "failure-report/implementation-handoff/v1"
      ) {
        return {
          status: "completed",
          report_id: input.report_id,
          implementation_handoff: rendered,
        };
      }
      return {
        status: "needs_input",
        report_id: input.report_id,
        human_input_request: rendered,
      };
    } catch (error) {
      if (
        error instanceof HandoffNeedsInputError ||
        error instanceof WorkpadNeedsInputError
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

type VerifiedHead = {
  issue: GithubIssueSnapshot;
  workpad: ExistingWorkpad;
};

async function readVerifiedHead(
  gateway: GithubIssueGateway,
  input: Pick<RenderDiagnosticHandoffRequest, "repository" | "issue_number">,
): Promise<VerifiedHead> {
  const issue = await gateway.readIssue(input.repository, input.issue_number);
  const workpad = findExistingWorkpad(
    issue,
    gateway.getWorkpadProducerConfiguration(),
  );
  if (!workpad) {
    throw new HandoffNeedsInputError(
      "Handoff rendering requires a valid Root-managed workpad.",
    );
  }
  return { issue, workpad };
}

function assertCallerBinding(
  workpad: ExistingWorkpad,
  input: RenderDiagnosticHandoffRequest,
): void {
  const report = workpad.report;
  const context = report.shared_context;
  if (
    report.id !== input.report_id ||
    !context ||
    context.repository !== input.repository ||
    context.issue_number !== input.issue_number
  ) {
    throw new HandoffNeedsInputError(
      "Latest managed workpad does not match the caller's report and Issue identity.",
    );
  }
  if (
    workpad.revision !== input.expected_workpad_revision ||
    context.workpad_revision !== input.expected_workpad_revision ||
    workpad.logical_session_id !== input.expected_workpad_logical_session_id ||
    workpad.entry.entry_id !== input.expected_workpad_entry_id
  ) {
    throw new HandoffNeedsInputError(
      "Caller-supplied workpad state is stale or has conflicting lineage; reload the latest managed workpad.",
    );
  }
  if (report.target.revision !== input.expected_target_revision) {
    throw new HandoffNeedsInputError(
      "Latest managed workpad target revision does not match the caller's immutable target revision.",
    );
  }
}

function workpadReadIdentity(head: VerifiedHead): string {
  return JSON.stringify({
    issue_updated_at: head.issue.updated_at,
    comment_ref: head.workpad.comment.id,
    comment_updated_at: head.workpad.comment.updated_at,
    revision: head.workpad.revision,
    logical_session_id: head.workpad.logical_session_id,
    entry_id: head.workpad.entry.entry_id,
    target_revision: head.workpad.report.target.revision,
  });
}
