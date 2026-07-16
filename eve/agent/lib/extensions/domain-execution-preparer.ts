import {
  executionPreparationEnvelopeSchema,
  type ExecutionPreparationEnvelope,
} from "../execution/envelope.js";
import { ExecutionWorkpad } from "../execution/workpad.js";
import {
  ExecutionSafetyError,
  ExecutionWorktreeManager,
} from "../execution/worktree.js";

/** Consumer-neutral request supplied by a mounted domain extension. */
export type DomainExecutionPreparation<DomainId extends string = string> = {
  domain_id: DomainId;
  report_id: string;
  repository: string;
  issue_number: number;
  request: string;
};

/** Stable result the host gives back to an extension after workpad preparation. */
export type DomainExecutionPreparationResult<DomainId extends string = string> =
  | {
      status: "prepared";
      domain_id: DomainId;
      report_id: string;
      workpad_revision: number;
      delegation_message: string;
    }
  | {
      status: "needs_input";
      domain_id: DomainId;
      report_id: string;
      reason: string;
    };

/** Provider policy the consuming application owns rather than an extension. */
export type DomainExecutionPreparerOptions = {
  backend_id: string;
  worktree_root?: string;
};

/**
 * Creates the consumer-owned bridge used by mounted extensions.
 *
 * The extension supplies its stable domain identity; this application retains
 * the worktree root, backend policy, and Issue-backed workpad implementation.
 */
export function createDomainExecutionPreparer<DomainId extends string>(
  options: DomainExecutionPreparerOptions,
): (
  input: DomainExecutionPreparation<DomainId>,
) => Promise<DomainExecutionPreparationResult<DomainId>> {
  return async (input) => {
    try {
      const workpad = new ExecutionWorkpad({
        worktrees: new ExecutionWorktreeManager({
          domainId: input.domain_id,
          backendId: options.backend_id,
          root: options.worktree_root,
        }),
      });
      const prepared = await workpad.prepare(
        executionPreparationEnvelopeSchema.parse({
          schema_version: "failure-report/execution/v1",
          ...input,
        }) as ExecutionPreparationEnvelope,
      );
      return {
        status: "prepared",
        domain_id: input.domain_id,
        report_id: prepared.report.id,
        workpad_revision: prepared.workpad_revision,
        delegation_message: prepared.delegation_message,
      };
    } catch (error) {
      if (error instanceof ExecutionSafetyError) {
        return {
          status: "needs_input",
          domain_id: input.domain_id,
          report_id: input.report_id,
          reason: error.message,
        };
      }
      throw error;
    }
  };
}
