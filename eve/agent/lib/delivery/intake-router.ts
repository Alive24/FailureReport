import {
  findRepositoryHandoffDeliveryPolicy,
  readHandoffDeliveryPolicy,
  type HandoffDeliveryEnvironment,
  type HandoffDeliveryPolicy,
} from "./handoff-delivery-config.js";
import {
  getDefaultGithubProjectTracker,
  type GithubProjectTracker,
} from "../integrations/github/project-tracker.js";
import { WorkpadNeedsInputError } from "../integrations/github/issue-workpad.js";

export type FailureReportIntakeRouterOptions = {
  environment?: HandoffDeliveryEnvironment;
  policy?: HandoffDeliveryPolicy;
  tracker?: GithubProjectTracker | Promise<GithubProjectTracker>;
};

/**
 * Routes one accepted diagnostic entry into the configured Failure Report lane.
 * Active downstream implementation/review states are never overwritten.
 */
export function createFailureReportIntakeRouter(
  options: FailureReportIntakeRouterOptions = {},
): (input: {
  repository: string;
  issue_number: number;
}) => Promise<
  | { status: "completed"; state: "Failure Report" }
  | { status: "not_configured" }
  | { status: "needs_input"; reason: string }
> {
  return async (input) => {
    let policy: HandoffDeliveryPolicy | undefined;
    try {
      policy =
        options.policy ??
        readHandoffDeliveryPolicy(options.environment ?? process.env);
    } catch {
      return {
        status: "needs_input",
        reason: "FAILURE_REPORT_HANDOFF_DELIVERY_POLICY is invalid.",
      };
    }
    if (!policy) {
      return { status: "not_configured" };
    }
    const repositoryPolicy = findRepositoryHandoffDeliveryPolicy(
      policy,
      input.repository,
    );
    if (!repositoryPolicy) {
      return { status: "not_configured" };
    }
    try {
      const tracker = await Promise.resolve(
        options.tracker ?? getDefaultGithubProjectTracker(),
      );
      await tracker.setIssueState({
        repository: input.repository,
        issue_number: input.issue_number,
        tracker: {
          project_owner: repositoryPolicy.tracker.project_owner,
          project_owner_type: repositoryPolicy.tracker.project_owner_type,
          project_number: repositoryPolicy.tracker.project_number,
          status_field: repositoryPolicy.tracker.status_field,
        },
        state: repositoryPolicy.tracker.intake_state,
        allowed_previous_states: [
          null,
          repositoryPolicy.tracker.intake_state,
          "Need Human Input",
          "Backlog",
          "Todo",
        ],
      });
      return {
        status: "completed",
        state: repositoryPolicy.tracker.intake_state,
      };
    } catch (error) {
      if (error instanceof WorkpadNeedsInputError) {
        return { status: "needs_input", reason: error.message };
      }
      return {
        status: "needs_input",
        reason:
          "Configured FailureReport intake routing could not be verified; inspect the Root host provider configuration and retry.",
      };
    }
  };
}
