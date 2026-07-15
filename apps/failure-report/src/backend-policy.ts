import { z } from "zod";

const agentModelSchema = z
  .object({
    model: z.string().min(1),
    reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

export const backendPolicySchema = z
  .object({
    schema_version: z.literal("failure-report/backend-policy/v1"),
    agent: agentModelSchema,
    investigator: z
      .object({
        kind: z.literal("codex_app_server"),
        command: z.string().min(1),
        arguments: z.array(z.string()),
        model: z.string().min(1).optional(),
        timeout_ms: z.number().int().positive(),
        approval_policy: z.enum(["untrusted", "on-request", "never"]),
      })
      .strict(),
  })
  .strict();

export type BackendPolicy = z.infer<typeof backendPolicySchema>;

export function parseBackendPolicy(value: unknown): BackendPolicy {
  return backendPolicySchema.parse(value);
}
