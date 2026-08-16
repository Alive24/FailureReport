import {
  findRepositoryHandoffDeliveryPolicy,
  loadHandoffTemplate,
  readHandoffDeliveryPolicy,
  type HandoffDeliveryEnvironment,
  type HandoffDeliveryPolicy,
} from "./delivery/handoff-delivery-config.js";
import {
  DiagnosticTargetWorkspaceManager,
  type PreflightedDiagnosticTarget,
} from "./diagnostics/target-workspace.js";
import {
  prepareTargetSheaWorkspace,
  verifyTargetSheaWriteAuthority,
  type TargetSheaWorkspace,
} from "./diagnostics/target-shea.js";
import {
  hostWorktreePathOperations,
  runHostGit,
} from "./diagnostics/worktree.js";
import { FailureReportRuntimeError } from "./runtime-failures.js";

type StartupSourceResolver = {
  preflight(): Promise<PreflightedDiagnosticTarget>;
};

export type HostRuntimeReadinessOptions = {
  environment?: HandoffDeliveryEnvironment;
  policy?: HandoffDeliveryPolicy;
  source_resolver?: StartupSourceResolver;
  prepare_target_shea?: (input: {
    canonicalCheckout: string;
  }) => Promise<TargetSheaWorkspace>;
  verify_write_authority?: (worktreeRoot: string) => Promise<void>;
  template_loader?: typeof loadHandoffTemplate;
};

export type HostRuntimeReadinessResult = {
  status: "ready";
  delivery_policy: "configured" | "not_configured";
};

/**
 * Proves all host facts available before an Issue operation exists. Repository
 * and immutable revision matching deliberately remain in acquire/restore.
 */
export async function preflightHostRuntime(
  options: HostRuntimeReadinessOptions = {},
): Promise<HostRuntimeReadinessResult> {
  const environment = options.environment ?? process.env;
  const sourceResolver =
    options.source_resolver ??
    new DiagnosticTargetWorkspaceManager({
      environment,
      git: runHostGit,
      paths: hostWorktreePathOperations,
    });
  const source = await sourceResolver.preflight();
  const targetShea = await (
    options.prepare_target_shea ?? prepareTargetSheaWorkspace
  )({ canonicalCheckout: source.canonical_path });
  await (options.verify_write_authority ?? verifyTargetSheaWriteAuthority)(
    targetShea.worktree_root,
  );

  let policy: HandoffDeliveryPolicy | undefined;
  try {
    policy = options.policy ?? readHandoffDeliveryPolicy(environment);
  } catch {
    throw new FailureReportRuntimeError(
      "delivery_policy_invalid",
      "Configured handoff delivery policy could not be parsed safely.",
    );
  }
  if (!policy) {
    return { status: "ready", delivery_policy: "not_configured" };
  }

  const repository = policy.repositories.find((candidate) =>
    remoteMatchesRepository(source.canonical_remote, candidate.repository),
  )?.repository;
  if (!repository) {
    return { status: "ready", delivery_policy: "not_configured" };
  }
  const repositoryPolicy = findRepositoryHandoffDeliveryPolicy(
    policy,
    repository,
  );
  if (!repositoryPolicy) {
    throw new FailureReportRuntimeError("delivery_policy_invalid");
  }
  await (options.template_loader ?? loadHandoffTemplate)(
    source.canonical_path,
    repositoryPolicy.template.path,
  );
  return { status: "ready", delivery_policy: "configured" };
}

function remoteMatchesRepository(remote: string, repository: string): boolean {
  const normalizedRemote = remote
    .trim()
    .replace(/\.git$/i, "")
    .toLowerCase();
  const normalizedRepository = repository.toLowerCase();
  return (
    normalizedRemote.endsWith("/" + normalizedRepository) ||
    normalizedRemote.endsWith(":" + normalizedRepository)
  );
}
