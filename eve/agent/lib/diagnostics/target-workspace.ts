import { isAbsolute, resolve } from "node:path";

import type { GitCommandRunner, WorktreePathOperations } from "./worktree.js";
import {
  FailureReportRuntimeError,
  type FailureReportRuntimeFailureCategory,
} from "../runtime-failures.js";

/** Host-only process configuration for the one repository this runtime serves. */
export const targetWorkspaceEnvironmentVariable =
  "FAILURE_REPORT_TARGET_WORKSPACE";

/** Signals that Root could not safely bind or verify its configured workspace. */
export class DiagnosticTargetWorkspaceError extends FailureReportRuntimeError {
  constructor(
    message: string,
    category: FailureReportRuntimeFailureCategory = "target_workspace_invalid",
  ) {
    super(category, message);
    this.name = "DiagnosticTargetWorkspaceError";
  }
}

/** Startup-safe facts available before an Issue supplies a repository/SHA. */
export type PreflightedDiagnosticTarget = {
  canonical_path: string;
  canonical_remote: string;
};

/** The private, process-bound checkout from which diagnostic worktrees are made. */
export type ResolvedDiagnosticSource = {
  canonical_path: string;
  canonical_remote: string;
  base_revision: string;
};

/** Root-owned source lifecycle used by the diagnostic worktree manager. */
export type DiagnosticSourceResolver = {
  acquire(report: DiagnosticSourceIdentity): Promise<ResolvedDiagnosticSource>;
  restore(
    report: DiagnosticSourceIdentity,
    recordedBaseRevision: string,
  ): Promise<ResolvedDiagnosticSource>;
};

/** Minimum Root-verified identity needed to select the bound target repository. */
export type DiagnosticSourceIdentity = {
  target: {
    repository: string;
    revision: string;
  };
  shared_context?: {
    repository: string;
  };
};

export type TargetWorkspacePathOperations = Pick<
  WorktreePathOperations,
  "lstat" | "realpath"
>;

export type DiagnosticTargetWorkspaceManagerOptions = {
  targetWorkspace?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  git: GitCommandRunner;
  paths: TargetWorkspacePathOperations;
  remoteForRepository?: (repository: string) => string;
};

/**
 * Resolves source only from the one host workspace selected when the
 * FailureReport process starts. Reports, Channels, models, MCP, and workpads
 * can identify a repository and immutable revision, but can never select a
 * local path.
 */
export class DiagnosticTargetWorkspaceManager implements DiagnosticSourceResolver {
  private readonly targetWorkspace: string;
  private readonly git: GitCommandRunner;
  private readonly paths: TargetWorkspacePathOperations;
  private readonly remoteForRepository: (repository: string) => string;

  constructor(options: DiagnosticTargetWorkspaceManagerOptions) {
    this.targetWorkspace =
      options.targetWorkspace ??
      readTargetWorkspace(options.environment ?? process.env);
    this.git = options.git;
    this.paths = options.paths;
    this.remoteForRepository =
      options.remoteForRepository ?? defaultRemoteForRepository;
  }

  /**
   * Proves the process-owned host boundary before Eve accepts work. Exact
   * repository and immutable revision verification remains in acquire/restore.
   */
  async preflight(): Promise<PreflightedDiagnosticTarget> {
    const canonicalPath = await this.resolveConfiguredWorkspace();
    await this.assertGitTopLevel(canonicalPath);
    const canonicalRemote = await this.readOrigin(canonicalPath);
    await this.fetch(canonicalPath);
    return {
      canonical_path: canonicalPath,
      canonical_remote: canonicalRemote,
    };
  }

  /** Fetches the bound checkout, then verifies the requested immutable SHA. */
  async acquire(
    report: DiagnosticSourceIdentity,
  ): Promise<ResolvedDiagnosticSource> {
    const source = await this.resolveBoundTarget(report);
    await this.fetch(source.canonical_path);
    const baseRevision = await this.resolveRequestedRevision(
      source.canonical_path,
      report.target.revision,
    );
    return { ...source, base_revision: baseRevision };
  }

  /**
   * Restores the recorded SHA without silently moving an active session. A
   * missing local object may be fetched once, but the resolved revision must
   * remain the exact persisted immutable commit.
   */
  async restore(
    report: DiagnosticSourceIdentity,
    recordedBaseRevision: string,
  ): Promise<ResolvedDiagnosticSource> {
    const source = await this.resolveBoundTarget(report);
    let baseRevision: string;
    try {
      baseRevision = await this.resolveCommit(
        source.canonical_path,
        recordedBaseRevision,
        "recorded diagnostic base revision",
      );
    } catch (error) {
      if (!(error instanceof DiagnosticTargetWorkspaceError)) {
        throw error;
      }
      await this.fetch(source.canonical_path);
      baseRevision = await this.resolveCommit(
        source.canonical_path,
        recordedBaseRevision,
        "recorded diagnostic base revision",
      );
    }
    if (!sameSha(baseRevision, recordedBaseRevision)) {
      throw new DiagnosticTargetWorkspaceError(
        "The bound target workspace did not resolve the recorded diagnostic base revision exactly.",
      );
    }
    return { ...source, base_revision: baseRevision };
  }

  private async resolveBoundTarget(
    report: DiagnosticSourceIdentity,
  ): Promise<Omit<ResolvedDiagnosticSource, "base_revision">> {
    const canonicalRemote = this.remoteForReport(report);
    const canonicalPath = await this.resolveConfiguredWorkspace();
    await this.assertGitTopLevel(canonicalPath);
    await this.assertOrigin(canonicalPath, canonicalRemote);
    return {
      canonical_path: canonicalPath,
      canonical_remote: canonicalRemote,
    };
  }

  private async resolveConfiguredWorkspace(): Promise<string> {
    if (!isAbsolute(this.targetWorkspace)) {
      throw new DiagnosticTargetWorkspaceError(
        "FailureReport's target workspace must be an absolute host path.",
      );
    }
    let declared: Awaited<ReturnType<TargetWorkspacePathOperations["lstat"]>>;
    let canonicalPath: string;
    try {
      declared = await this.paths.lstat(this.targetWorkspace);
      canonicalPath = await this.paths.realpath(this.targetWorkspace);
    } catch {
      throw new DiagnosticTargetWorkspaceError(
        "FailureReport's target workspace cannot be inspected safely.",
      );
    }
    if (declared.isSymbolicLink() || !declared.isDirectory()) {
      throw new DiagnosticTargetWorkspaceError(
        "FailureReport's target workspace must be a real directory, not a symlink or file.",
      );
    }
    return canonicalPath;
  }

  private async assertGitTopLevel(canonicalPath: string): Promise<void> {
    let declaredTopLevel: string;
    try {
      declaredTopLevel = await this.git({
        cwd: canonicalPath,
        args: ["rev-parse", "--show-toplevel"],
      });
    } catch {
      throw new DiagnosticTargetWorkspaceError(
        "FailureReport's target workspace is not a Git checkout.",
      );
    }
    let canonicalTopLevel: string;
    try {
      canonicalTopLevel = await this.paths.realpath(declaredTopLevel);
    } catch {
      throw new DiagnosticTargetWorkspaceError(
        "FailureReport could not resolve the target workspace's Git top level.",
      );
    }
    if (resolve(canonicalTopLevel) !== resolve(canonicalPath)) {
      throw new DiagnosticTargetWorkspaceError(
        "FailureReport's target workspace must be the canonical Git top-level directory.",
      );
    }
  }

  private remoteForReport(report: DiagnosticSourceIdentity): string {
    const issueRepository = report.shared_context?.repository;
    if (!issueRepository || issueRepository !== report.target.repository) {
      throw new DiagnosticTargetWorkspaceError(
        "The diagnostic report target repository must exactly match its Root-published GitHub Issue context.",
      );
    }
    let remote: string;
    try {
      remote = this.remoteForRepository(report.target.repository).trim();
    } catch {
      throw new DiagnosticTargetWorkspaceError(
        "Root could not derive a canonical remote for the diagnostic repository.",
      );
    }
    if (!remote || /\s/.test(remote)) {
      throw new DiagnosticTargetWorkspaceError(
        "Root derived an invalid canonical remote for the diagnostic repository.",
      );
    }
    return remote;
  }

  private async assertOrigin(
    canonicalPath: string,
    canonicalRemote: string,
  ): Promise<void> {
    const origin = await this.readOrigin(canonicalPath);
    if (normalizeRemote(origin) !== normalizeRemote(canonicalRemote)) {
      throw new DiagnosticTargetWorkspaceError(
        "The bound target workspace origin does not match the diagnostic repository.",
      );
    }
  }

  private async readOrigin(canonicalPath: string): Promise<string> {
    let origin: string;
    try {
      origin = await this.git({
        cwd: canonicalPath,
        args: ["remote", "get-url", "origin"],
      });
    } catch {
      throw new DiagnosticTargetWorkspaceError(
        "The bound target workspace has no readable origin remote.",
      );
    }
    if (!origin.trim() || /[\r\n]/.test(origin)) {
      throw new DiagnosticTargetWorkspaceError(
        "The bound target workspace has an invalid origin remote.",
      );
    }
    return origin.trim();
  }

  private async fetch(canonicalPath: string): Promise<void> {
    try {
      await this.git({
        cwd: canonicalPath,
        args: ["fetch", "--prune", "origin"],
      });
    } catch {
      throw new DiagnosticTargetWorkspaceError(
        "Root could not fetch the bound target workspace; verify host Git authentication, repository availability, and retry.",
        "git_fetch_failed",
      );
    }
  }

  private async resolveRequestedRevision(
    canonicalPath: string,
    requestedRevision: string,
  ): Promise<string> {
    const resolved = await this.resolveCommit(
      canonicalPath,
      requestedRevision,
      "requested diagnostic revision",
    );
    if (!sameSha(resolved, requestedRevision)) {
      throw new DiagnosticTargetWorkspaceError(
        "Root resolved a revision different from the immutable SHA requested by the diagnostic report.",
      );
    }
    return resolved;
  }

  private async resolveCommit(
    canonicalPath: string,
    revision: string,
    description: string,
  ): Promise<string> {
    if (!isImmutableSha(revision)) {
      throw new DiagnosticTargetWorkspaceError(
        "The " + description + " must be a full immutable Git SHA.",
      );
    }
    let resolved: string;
    try {
      resolved = await this.git({
        cwd: canonicalPath,
        args: ["rev-parse", "--verify", revision + "^{commit}"],
      });
    } catch {
      throw new DiagnosticTargetWorkspaceError(
        "Root could not resolve the " +
          description +
          " in the bound target workspace.",
      );
    }
    if (!isImmutableSha(resolved)) {
      throw new DiagnosticTargetWorkspaceError(
        "Root resolved a non-immutable value for the " + description + ".",
      );
    }
    return resolved;
  }
}

/** Reads the one process-level workspace binding; public requests cannot set it. */
export function readTargetWorkspace(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment[targetWorkspaceEnvironmentVariable]?.trim();
  if (!configured) {
    throw new DiagnosticTargetWorkspaceError(
      `${targetWorkspaceEnvironmentVariable} is required. Start FailureReport with --target-workspace <canonical-checkout>.`,
    );
  }
  if (!isAbsolute(configured)) {
    throw new DiagnosticTargetWorkspaceError(
      `${targetWorkspaceEnvironmentVariable} must be an absolute host path.`,
    );
  }
  return configured;
}

function defaultRemoteForRepository(repository: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("invalid repository identity");
  }
  const host = (process.env.FAILURE_REPORT_GITHUB_HOST ?? "github.com").trim();
  if (!/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(host)) {
    throw new Error("invalid GitHub host");
  }
  return "https://" + host + "/" + repository + ".git";
}

function normalizeRemote(remote: string): string {
  return remote
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

function isImmutableSha(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
}

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
