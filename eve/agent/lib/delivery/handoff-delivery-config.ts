import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/** Deployment-owned policy for publishing a ready handoff into one tracker. */
export const handoffDeliveryPolicySchema = z
  .object({
    schema_version: z.literal("failure-report/handoff-delivery-policy/v1"),
    repositories: z
      .array(
        z
          .object({
            repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
            template: z
              .object({
                path: z
                  .string()
                  .min(1)
                  .refine((path) => !isAbsolute(path), {
                    message: "handoff template path must be relative",
                  }),
              })
              .strict(),
            tracker: z
              .object({
                kind: z.literal("github_project_v2"),
                project_owner: z.string().min(1),
                project_owner_type: z.enum(["organization", "user"]),
                project_number: z.number().int().positive(),
                status_field: z.string().min(1),
                intake_state: z.literal("Failure Report"),
                ready_destination: z.enum(["Backlog", "Todo"]),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((policy, context) => {
    const repositories = new Set<string>();
    for (let index = 0; index < policy.repositories.length; index += 1) {
      const repository = policy.repositories[index];
      if (!repository) {
        continue;
      }
      const normalized = repository.repository.toLowerCase();
      if (repositories.has(normalized)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "handoff delivery repositories must be unique",
          path: ["repositories", index, "repository"],
        });
      }
      repositories.add(normalized);
    }
  });

export type HandoffDeliveryPolicy = z.infer<typeof handoffDeliveryPolicySchema>;
export type RepositoryHandoffDeliveryPolicy =
  HandoffDeliveryPolicy["repositories"][number];

export type HandoffDeliveryEnvironment = Readonly<
  Record<string, string | undefined>
>;

const POLICY_ENVIRONMENT_VARIABLE = "FAILURE_REPORT_HANDOFF_DELIVERY_POLICY";

/**
 * Reads the optional delivery policy. Rendering remains available without one;
 * mutating intake or delivery tools fail closed until a deployment opts in.
 */
export function readHandoffDeliveryPolicy(
  environment: HandoffDeliveryEnvironment = process.env,
): HandoffDeliveryPolicy | undefined {
  const serialized = environment[POLICY_ENVIRONMENT_VARIABLE]?.trim();
  if (!serialized) {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw new Error(
      "FAILURE_REPORT_HANDOFF_DELIVERY_POLICY must be valid JSON.",
    );
  }
  return handoffDeliveryPolicySchema.parse(decoded);
}

/** Resolves one exact repository policy without caller-selected tracker fields. */
export function findRepositoryHandoffDeliveryPolicy(
  policy: HandoffDeliveryPolicy,
  repository: string,
): RepositoryHandoffDeliveryPolicy | undefined {
  const normalized = repository.toLowerCase();
  return policy.repositories.find(
    (candidate) => candidate.repository.toLowerCase() === normalized,
  );
}

/**
 * Finds the Eve application root from normal source, compiled, repository-root,
 * or package-root launch locations without accepting a caller path.
 */
export async function resolveEveApplicationRoot(
  workingDirectory = process.cwd(),
): Promise<string> {
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    workingDirectory,
    resolve(workingDirectory, "eve"),
    resolve(moduleDirectory, "../../.."),
    resolve(moduleDirectory, "../../../.."),
  ];
  for (const candidate of new Set(candidates)) {
    try {
      const packageJson = JSON.parse(
        await readFile(resolve(candidate, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (packageJson.name === "@Alive24/FailureReport") {
        return realpath(candidate);
      }
    } catch {
      // Try the next bounded application-owned candidate.
    }
  }
  throw new Error(
    "FailureReport could not resolve its Eve application root for handoff templates.",
  );
}

/**
 * Loads a configured Markdown template only from inside the Eve application
 * root. Canonical containment rejects traversal and symlink escapes.
 */
export async function loadHandoffTemplate(
  applicationRoot: string,
  configuredPath: string,
): Promise<{ content: string; canonical_path: string }> {
  const canonicalRoot = await realpath(applicationRoot);
  const candidate = resolve(canonicalRoot, configuredPath);
  const canonicalPath = await realpath(candidate);
  const fromRoot = relative(canonicalRoot, canonicalPath);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith("../") ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(
      "Configured handoff template must resolve to a file inside the Eve application root.",
    );
  }
  if (!(await stat(canonicalPath)).isFile()) {
    throw new Error("Configured handoff template must resolve to a file.");
  }
  const content = await readFile(canonicalPath, "utf8");
  if (!content.trim()) {
    throw new Error("Configured handoff template must not be empty.");
  }
  return { content, canonical_path: canonicalPath };
}
