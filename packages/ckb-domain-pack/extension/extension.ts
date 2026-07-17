import { defineExtension } from "eve/extension";

/** Stable internal identifier for this CKB extension. */
export const ckbDomainId = "ckb";

/**
 * Pure CKB capability package. It contributes instructions, a native skill, and
 * deterministic tools only; Root owns diagnostic-session preparation, sandbox,
 * worktree, and declared-subagent policy in the consuming application.
 */
export default defineExtension({});
