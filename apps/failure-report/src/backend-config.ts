import { z } from "zod";

const modelContextWindowTokens = z.number().int().positive();

export const rootBackendConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schema_version: z.literal("failure-report/root-backend/v1"),
      kind: z.literal("experimental_chatgpt"),
      model: z.string().min(1).optional(),
      model_context_window_tokens: modelContextWindowTokens,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal("failure-report/root-backend/v1"),
      kind: z.literal("gateway_model"),
      model: z.string().min(1),
      model_context_window_tokens: modelContextWindowTokens,
    })
    .strict(),
]);

export const ckbBackendConfigSchema = z
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

export type RootBackendConfig = z.infer<typeof rootBackendConfigSchema>;
export type CkbBackendConfig = z.infer<typeof ckbBackendConfigSchema>;

export function parseRootBackendConfig(value: unknown): RootBackendConfig {
  return rootBackendConfigSchema.parse(value);
}

export function parseCkbBackendConfig(value: unknown): CkbBackendConfig {
  return ckbBackendConfigSchema.parse(value);
}
