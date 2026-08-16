import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import {
  DiagnosticTargetWorkspaceManager,
  type DiagnosticSourceResolver,
} from "../diagnostics/target-workspace.js";
import { prepareTargetSheaWorkspace } from "../diagnostics/target-shea.js";
import {
  hostWorktreePathOperations,
  runHostGit,
} from "../diagnostics/worktree.js";
import { FailureReportRuntimeError } from "../runtime-failures.js";

export const defaultTargetHandoffTemplatePath =
  ".shea/template/failureReport/implementation.md";

/** Deployment-owned policy for target handoff presentation and optional routing. */
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
                  })
                  .default(defaultTargetHandoffTemplatePath),
              })
              .strict()
              .default({ path: defaultTargetHandoffTemplatePath }),
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
              .strict()
              .nullable()
              .default(null),
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
 * Loads a configured Markdown template only from inside the target canonical
 * checkout. Canonical containment rejects traversal and symlink escapes.
 */
export async function loadHandoffTemplate(
  canonicalCheckout: string,
  configuredPath: string,
): Promise<{ content: string; canonical_path: string }> {
  try {
    const canonicalRoot = await realpath(canonicalCheckout);
    const candidate = resolve(canonicalRoot, configuredPath);
    const canonicalPath = await realpath(candidate);
    const fromRoot = relative(canonicalRoot, canonicalPath);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith("../") ||
      isAbsolute(fromRoot)
    ) {
      throw new Error("template escaped the target checkout");
    }
    if (!(await stat(canonicalPath)).isFile()) {
      throw new Error("template is not a regular file");
    }
    const content = await readFile(canonicalPath, "utf8");
    if (!content.trim()) {
      throw new Error("template is empty");
    }
    return { content, canonical_path: canonicalPath };
  } catch (error) {
    if (error instanceof FailureReportRuntimeError) {
      throw error;
    }
    throw new FailureReportRuntimeError(
      "handoff_template_invalid",
      "Configured target handoff template could not be validated safely.",
    );
  }
}

/**
 * Acquires the Root-resolved target checkout, bootstraps missing defaults, and
 * loads the target-owned handoff template. No caller can supply a host path.
 */
export async function loadTargetHandoffTemplate(input: {
  repository: string;
  revision: string;
  configuredPath?: string;
  sourceResolver?: DiagnosticSourceResolver;
}): Promise<{ content: string; canonical_path: string }> {
  const sourceResolver =
    input.sourceResolver ??
    new DiagnosticTargetWorkspaceManager({
      git: runHostGit,
      paths: hostWorktreePathOperations,
    });
  const source = await sourceResolver.acquire({
    target: {
      repository: input.repository,
      revision: input.revision,
    },
    shared_context: {
      repository: input.repository,
    },
  });
  await prepareTargetSheaWorkspace({
    canonicalCheckout: source.canonical_path,
  });
  return loadHandoffTemplate(
    source.canonical_path,
    input.configuredPath ?? defaultTargetHandoffTemplatePath,
  );
}
