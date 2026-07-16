import { defineExtension } from "eve/extension";
import { z } from "zod";

/** Stable internal identifier for this CKB extension. */
export const ckbDomainId = "ckb";

/** Input supplied by this extension to the consumer-owned execution host. */
export type CkbExecutionPreparation = {
  domain_id: typeof ckbDomainId;
  report_id: string;
  repository: string;
  issue_number: number;
  request: string;
};

/** Result returned by the consumer after durable execution preparation. */
export type CkbExecutionPreparationResult =
  | {
      status: "prepared";
      domain_id: typeof ckbDomainId;
      report_id: string;
      workpad_revision: number;
      delegation_message: string;
    }
  | {
      status: "needs_input";
      domain_id: typeof ckbDomainId;
      report_id: string;
      reason: string;
    };

/**
 * Consumer-owned capability injected at mount time.
 *
 * Extensions cannot own agent configuration or a subagent, so the application
 * retains its provider/worktree policy while this package retains CKB behavior.
 */
export type CkbExecutionPreparer = (
  input: CkbExecutionPreparation,
) => Promise<CkbExecutionPreparationResult>;

const executionPreparerSchema = z.custom<CkbExecutionPreparer>(
  (value) => typeof value === "function",
  "prepareExecution must be a function",
);

export default defineExtension({
  config: z.object({
    prepareExecution: executionPreparerSchema,
  }),
});
