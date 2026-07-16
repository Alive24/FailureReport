import type { ModelMessage } from "ai";

import {
  executionEnvelopeSchema,
  executionPreparationEnvelopeSchema,
  parseExecutionEnvelope,
  type ExecutionEnvelope,
  type ExecutionPreparationEnvelope,
} from "../../execution/envelope.js";
import { ExecutionWorkpad } from "../../execution/workpad.js";
import { ExecutionWorktreeManager } from "../../execution/worktree.js";
import type { CkbCodexBackendConfig } from "./config.js";

/** CKB domain-pack bindings for generic Root-owned execution infrastructure. */

/** Stable internal identifier used to select the CKB domain pack. */
export const ckbDomainId = "ckb";
/** Stable backend identifier persisted with CKB execution state. */
export const ckbCodexBackendId = "codex_app_server";

/** Generic execution envelope narrowed to the CKB domain. */
export type CkbExecutionEnvelope = ExecutionEnvelope & {
  domain_id: typeof ckbDomainId;
};

/** CKB delegation input before Root has assigned a workpad revision. */
export type CkbExecutionPreparationEnvelope = ExecutionPreparationEnvelope & {
  domain_id: typeof ckbDomainId;
};

/** Builds the only CKB execution identity that Root may prepare. */
export function createCkbExecutionEnvelope(input: {
  report_id: string;
  repository: string;
  issue_number: number;
  request: string;
}): CkbExecutionPreparationEnvelope {
  return executionPreparationEnvelopeSchema.parse({
    schema_version: "failure-report/execution/v1",
    domain_id: ckbDomainId,
    ...input,
  }) as CkbExecutionPreparationEnvelope;
}

/**
 * Reads the generic envelope and rejects delegation intended for another domain.
 * This check keeps a CKB provider from accepting a valid-looking envelope that
 * was prepared for a different backend or instruction set.
 */
export function parseCkbExecutionEnvelope(
  messages: readonly ModelMessage[],
): CkbExecutionEnvelope {
  const envelope = parseExecutionEnvelope(messages);
  if (envelope.domain_id !== ckbDomainId) {
    throw new Error(
      "CKB execution is blocked because Root prepared a different domain envelope: " +
        envelope.domain_id,
    );
  }
  return executionEnvelopeSchema.parse(envelope) as CkbExecutionEnvelope;
}

/** Creates CKB's configured bridge to the generic workpad/worktree lifecycle. */
export function createCkbExecutionWorkpad(
  config: CkbCodexBackendConfig,
): ExecutionWorkpad {
  return new ExecutionWorkpad({
    worktrees: new ExecutionWorktreeManager({
      domainId: ckbDomainId,
      backendId: ckbCodexBackendId,
      root: config.worktree_root,
    }),
  });
}
