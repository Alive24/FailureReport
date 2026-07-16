import { z } from "zod";

/** Configuration contract for the CKB pack's Codex App-server backend. */

const modelContextWindowTokens = z.number().int().positive();

/** Validates CKB's local Codex App-server provider configuration. */
export const ckbCodexBackendConfigSchema = z
  .object({
    schema_version: z.literal("failure-report/ckb-backend/v1"),
    kind: z.literal("codex_app_server"),
    codex_path: z.string().min(1),
    model: z.string().min(1),
    approval_mode: z.enum(["untrusted", "on-request", "never"]),
    sandbox_mode: z.enum([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]),
    reasoning_effort: z.enum(["low", "medium", "high"]),
    model_context_window_tokens: modelContextWindowTokens,
    worktree_root: z.string().min(1).optional(),
  })
  .strict();

/** Typed CKB backend configuration inferred from the validated schema. */
export type CkbCodexBackendConfig = z.infer<typeof ckbCodexBackendConfigSchema>;

/** Parses unknown JSON before it is used to create a Codex App-server provider. */
export function parseCkbCodexBackendConfig(
  value: unknown,
): CkbCodexBackendConfig {
  return ckbCodexBackendConfigSchema.parse(value);
}
