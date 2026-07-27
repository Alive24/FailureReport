import {
  type HandoffDeliveryReceipt,
  type ImplementationHandoff,
} from "@failure-report/protocol";

import { createDiagnosticHandoffRenderer } from "../diagnostics/handoff-renderer.js";
import type { RenderDiagnosticHandoffResult } from "../diagnostics/handoff-renderer.js";
import { getDefaultGithubIssueGateway } from "../integrations/github/gateway-factory.js";
import type { GithubIssueGateway } from "../integrations/github/issue-gateway.js";
import { WorkpadNeedsInputError } from "../integrations/github/issue-workpad.js";
import {
  getDefaultGithubProjectTracker,
  type GithubProjectTracker,
} from "../integrations/github/project-tracker.js";
import {
  findRepositoryHandoffDeliveryPolicy,
  loadHandoffTemplate,
  readHandoffDeliveryPolicy,
  resolveEveApplicationRoot,
  type HandoffDeliveryEnvironment,
  type HandoffDeliveryPolicy,
  type RepositoryHandoffDeliveryPolicy,
} from "./handoff-delivery-config.js";
import {
  createHandoffDeliveryReceipt,
  prepareHandoffDelivery,
} from "./handoff-template.js";

/** Revision bindings shared with the pure renderer. */
export type DeliverDiagnosticHandoffRequest = {
  report_id: string;
  repository: string;
  issue_number: number;
  expected_workpad_revision: number;
  expected_workpad_logical_session_id: string;
  expected_workpad_entry_id: string;
  expected_target_revision: string;
};

export type DeliverDiagnosticHandoffResult =
  | {
      status: "completed";
      report_id: string;
      implementation_handoff: ImplementationHandoff;
      handoff_delivery: HandoffDeliveryReceipt;
    }
  | {
      status: "needs_input";
      report_id: string;
      reason: string;
    };

export type DiagnosticHandoffDeliveryOptions = {
  applicationRoot?: string;
  environment?: HandoffDeliveryEnvironment;
  gateway?: GithubIssueGateway | Promise<GithubIssueGateway>;
  policy?: HandoffDeliveryPolicy;
  renderer?: (
    input: DeliverDiagnosticHandoffRequest,
  ) => Promise<RenderDiagnosticHandoffResult>;
  tracker?: GithubProjectTracker | Promise<GithubProjectTracker>;
  templateLoader?: typeof loadHandoffTemplate;
};

/**
 * Creates FailureReport's configured side-effect boundary.
 *
 * The pure renderer still establishes a revision-bound handoff. Delivery then
 * creates or reuses one marker-bound comment before moving the Project item to
 * Backlog or Todo and returns only after tracker readback.
 */
export function createDiagnosticHandoffDelivery(
  options: DiagnosticHandoffDeliveryOptions = {},
): (
  input: DeliverDiagnosticHandoffRequest,
) => Promise<DeliverDiagnosticHandoffResult> {
  return async (input) => {
    let policy: HandoffDeliveryPolicy | undefined;
    try {
      policy =
        options.policy ??
        readHandoffDeliveryPolicy(options.environment ?? process.env);
    } catch {
      return needsInput(
        input.report_id,
        "FAILURE_REPORT_HANDOFF_DELIVERY_POLICY is invalid.",
      );
    }
    if (!policy) {
      return needsInput(
        input.report_id,
        "Handoff delivery requires FAILURE_REPORT_HANDOFF_DELIVERY_POLICY.",
      );
    }
    const repositoryPolicy = findRepositoryHandoffDeliveryPolicy(
      policy,
      input.repository,
    );
    if (!repositoryPolicy) {
      return needsInput(
        input.report_id,
        "No handoff delivery policy is configured for the target repository.",
      );
    }

    try {
      const gateway = await Promise.resolve(
        options.gateway ?? getDefaultGithubIssueGateway(),
      );
      const renderer =
        options.renderer ?? createDiagnosticHandoffRenderer({ gateway });
      const rendered = await renderer(input);
      if (
        rendered.status !== "completed" ||
        !("implementation_handoff" in rendered)
      ) {
        return needsInput(
          input.report_id,
          "reason" in rendered
            ? rendered.reason
            : "A material unknown still requires human input before handoff delivery.",
        );
      }

      const template = await (options.templateLoader ?? loadHandoffTemplate)(
        options.applicationRoot ?? (await resolveEveApplicationRoot()),
        repositoryPolicy.template.path,
      );
      const prepared = prepareHandoffDelivery({
        handoff: rendered.implementation_handoff,
        policy: repositoryPolicy,
        template: template.content,
      });
      const comment = await gateway.publishHandoffComment(
        input.repository,
        input.issue_number,
        prepared.marker,
        prepared.comment_body,
      );
      const deliveryReadback = await renderer(input);
      if (
        deliveryReadback.status !== "completed" ||
        !("implementation_handoff" in deliveryReadback) ||
        deliveryReadback.implementation_handoff.handoff_id !==
          rendered.implementation_handoff.handoff_id
      ) {
        return needsInput(
          input.report_id,
          "Managed workpad changed before tracker delivery; reload the latest revision before retrying.",
        );
      }
      const tracker = await Promise.resolve(
        options.tracker ?? getDefaultGithubProjectTracker(),
      );
      await tracker.setIssueState({
        repository: input.repository,
        issue_number: input.issue_number,
        tracker: trackerCoordinates(repositoryPolicy),
        state: repositoryPolicy.tracker.ready_destination,
        allowed_previous_states: [
          null,
          repositoryPolicy.tracker.intake_state,
          "Need Human Input",
          repositoryPolicy.tracker.ready_destination,
        ],
      });
      return {
        status: "completed",
        report_id: input.report_id,
        implementation_handoff: rendered.implementation_handoff,
        handoff_delivery: createHandoffDeliveryReceipt({
          handoff: rendered.implementation_handoff,
          policy: repositoryPolicy,
          prepared,
          comment_ref: comment.comment_ref,
        }),
      };
    } catch (error) {
      if (error instanceof WorkpadNeedsInputError) {
        return needsInput(input.report_id, error.message);
      }
      return needsInput(
        input.report_id,
        "Configured handoff delivery could not be verified; inspect the Root host provider configuration and retry.",
      );
    }
  };
}

function trackerCoordinates(policy: RepositoryHandoffDeliveryPolicy): {
  project_owner: string;
  project_owner_type: "organization" | "user";
  project_number: number;
  status_field: string;
} {
  return {
    project_owner: policy.tracker.project_owner,
    project_owner_type: policy.tracker.project_owner_type,
    project_number: policy.tracker.project_number,
    status_field: policy.tracker.status_field,
  };
}

function needsInput(
  reportId: string,
  reason: string,
): DeliverDiagnosticHandoffResult {
  return {
    status: "needs_input",
    report_id: reportId,
    reason,
  };
}
