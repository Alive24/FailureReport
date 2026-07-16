import { z } from "zod";

/** Root-provider configuration parsing, kept separate from worker backends. */

const modelContextWindowTokens = z.number().int().positive();

/**
 * Validates the Root model selection.
 * `experimental_chatgpt` is the intentional local-first product default; a
 * gateway model remains an explicit deployment-time alternative.
 */
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

/** Typed Root provider configuration inferred from the validated schema. */
export type RootBackendConfig = z.infer<typeof rootBackendConfigSchema>;

/** Parses untrusted JSON before Root constructs a tool-capable model. */
export function parseRootBackendConfig(value: unknown): RootBackendConfig {
  return rootBackendConfigSchema.parse(value);
}
