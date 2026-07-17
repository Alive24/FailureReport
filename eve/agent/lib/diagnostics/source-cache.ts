import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FailureReport } from "@failure-report/protocol";

import type { GitCommandRunner, WorktreePathOperations } from "./worktree.js";

/** Signals that Root could not safely acquire or verify a host-managed source cache. */
export class DiagnosticSourceCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticSourceCacheError";
  }
}

/** The private, Root-owned source checkout from which a diagnostic worktree is made. */
export type ResolvedDiagnosticSource = {
  canonical_path: string;
  canonical_remote: string;
  base_revision: string;
};

/** Root-owned source lifecycle used by the diagnostic worktree manager. */
export type DiagnosticSourceResolver = {
  acquire(report: FailureReport): Promise<ResolvedDiagnosticSource>;
  restore(
    report: FailureReport,
    recordedBaseRevision: string,
  ): Promise<ResolvedDiagnosticSource>;
};

/** Canonical paths for the one local workspace hierarchy Root is allowed to own. */
export type ManagedDiagnosticWorkspaceLayout = {
  runtime_root: string;
  eve_root: string;
  sandbox_cache_root: string;
  source_root: string;
  worktree_root: string;
};

/** Filesystem operations needed to establish the controlled local hierarchy. */
export type ManagedWorkspacePathOperations = Pick<
  WorktreePathOperations,
  "ensureDirectory" | "lstat" | "realpath"
>;

/**
 * Resolves and validates Root's fixed local workspace hierarchy.
 *
 * `runtimeRoot` is an authored host-runtime seam for tests and packaging, never
 * a caller, model, report, workpad, MCP, or Codex input. The effective source
 * and worktree roots are always children of `<runtimeRoot>/.eve/sandbox-cache`.
 */
export async function resolveManagedDiagnosticWorkspaceLayout(input: {
  runtimeRoot?: string;
  paths: ManagedWorkspacePathOperations;
}): Promise<ManagedDiagnosticWorkspaceLayout> {
  const configuredRuntimeRoot = resolve(
    input.runtimeRoot ?? resolveFailureReportRuntimeRoot(),
  );
  let runtimeRoot: string;
  try {
    runtimeRoot = await input.paths.realpath(configuredRuntimeRoot);
  } catch {
    throw new DiagnosticSourceCacheError(
      "FailureReport's host runtime root cannot be resolved safely.",
    );
  }

  const eveRoot = await resolveOwnedDirectory(
    input.paths,
    runtimeRoot,
    join(runtimeRoot, ".eve"),
    "FailureReport .eve directory",
  );
  const sandboxCacheRoot = await resolveOwnedDirectory(
    input.paths,
    eveRoot,
    join(eveRoot, "sandbox-cache"),
    "FailureReport sandbox cache",
  );
  const sourceRoot = await resolveOwnedDirectory(
    input.paths,
    sandboxCacheRoot,
    join(sandboxCacheRoot, "sources"),
    "FailureReport source cache",
  );
  const worktreeRoot = await resolveOwnedDirectory(
    input.paths,
    sandboxCacheRoot,
    join(sandboxCacheRoot, "worktrees"),
    "FailureReport diagnostic-worktree root",
  );

  return {
    runtime_root: runtimeRoot,
    eve_root: eveRoot,
    sandbox_cache_root: sandboxCacheRoot,
    source_root: sourceRoot,
    worktree_root: worktreeRoot,
  };
}

/** Configuration for persistent source acquisition in Root's host-managed cache. */
export type DiagnosticSourceCacheManagerOptions = {
  runtimeRoot?: string;
  git: GitCommandRunner;
  paths: ManagedWorkspacePathOperations;
  remoteForRepository?: (repository: string) => string;
};

/**
 * Acquires source only from a Root-derived canonical remote. The cache path is
 * deterministic but never enters a report, delegation, result, or caller input.
 */
export class DiagnosticSourceCacheManager implements DiagnosticSourceResolver {
  private readonly runtimeRoot?: string;
  private readonly git: GitCommandRunner;
  private readonly paths: ManagedWorkspacePathOperations;
  private readonly remoteForRepository: (repository: string) => string;

  constructor(options: DiagnosticSourceCacheManagerOptions) {
    this.runtimeRoot = options.runtimeRoot;
    this.git = options.git;
    this.paths = options.paths;
    this.remoteForRepository =
      options.remoteForRepository ?? defaultRemoteForRepository;
  }

  /** Fetches the canonical cache, then verifies the exact requested immutable SHA. */
  async acquire(report: FailureReport): Promise<ResolvedDiagnosticSource> {
    const source = await this.loadOrCreate(report);
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
    report: FailureReport,
    recordedBaseRevision: string,
  ): Promise<ResolvedDiagnosticSource> {
    const source = await this.loadOrCreate(report);
    let baseRevision: string;
    try {
      baseRevision = await this.resolveCommit(
        source.canonical_path,
        recordedBaseRevision,
        "recorded diagnostic base revision",
      );
    } catch (error) {
      if (!(error instanceof DiagnosticSourceCacheError)) {
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
      throw new DiagnosticSourceCacheError(
        "The managed source cache did not resolve the recorded diagnostic base revision exactly.",
      );
    }
    return { ...source, base_revision: baseRevision };
  }

  private async loadOrCreate(
    report: FailureReport,
  ): Promise<Omit<ResolvedDiagnosticSource, "base_revision">> {
    const canonicalRemote = this.remoteForReport(report);
    const sourceRoot = await this.resolveSourceRoot();
    const declaredPath = join(
      sourceRoot,
      "source-" + sourceIdentity(canonicalRemote),
    );
    let canonicalPath: string | undefined;

    try {
      canonicalPath = await this.paths.realpath(declaredPath);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw new DiagnosticSourceCacheError(
          "The Root-owned source cache cannot be inspected safely.",
        );
      }
    }

    if (!canonicalPath) {
      try {
        await this.git({
          cwd: sourceRoot,
          args: [
            "clone",
            "--no-checkout",
            "--origin",
            "origin",
            canonicalRemote,
            declaredPath,
          ],
        });
      } catch {
        // A concurrent Root may have completed the same deterministic clone. It
        // is safe to continue only after re-reading and fully validating it.
        try {
          canonicalPath = await this.paths.realpath(declaredPath);
        } catch {
          throw new DiagnosticSourceCacheError(
            "Root could not create the managed source cache; verify host Git authentication, repository availability, and retry.",
          );
        }
      }
    }

    if (!canonicalPath) {
      canonicalPath = await this.paths.realpath(declaredPath);
    }
    await this.assertCachePath(sourceRoot, declaredPath, canonicalPath);
    await this.assertOrigin(canonicalPath, canonicalRemote);
    return { canonical_path: canonicalPath, canonical_remote: canonicalRemote };
  }

  private remoteForReport(report: FailureReport): string {
    const issueRepository = report.shared_context?.repository;
    if (!issueRepository || issueRepository !== report.target.repository) {
      throw new DiagnosticSourceCacheError(
        "The diagnostic report target repository must exactly match its Root-published GitHub Issue context.",
      );
    }
    let remote: string;
    try {
      remote = this.remoteForRepository(report.target.repository).trim();
    } catch {
      throw new DiagnosticSourceCacheError(
        "Root could not derive a canonical remote for the diagnostic repository.",
      );
    }
    if (!remote || /\s/.test(remote)) {
      throw new DiagnosticSourceCacheError(
        "Root derived an invalid canonical remote for the diagnostic repository.",
      );
    }
    return remote;
  }

  private async resolveSourceRoot(): Promise<string> {
    return (
      await resolveManagedDiagnosticWorkspaceLayout({
        runtimeRoot: this.runtimeRoot,
        paths: this.paths,
      })
    ).source_root;
  }

  private async assertCachePath(
    sourceRoot: string,
    declaredPath: string,
    canonicalPath: string,
  ): Promise<void> {
    if (!isPathInside(sourceRoot, canonicalPath)) {
      throw new DiagnosticSourceCacheError(
        "The managed source cache resolves outside Root-owned `.eve/sandbox-cache/sources`.",
      );
    }
    let stat: Awaited<ReturnType<ManagedWorkspacePathOperations["lstat"]>>;
    try {
      stat = await this.paths.lstat(declaredPath);
    } catch {
      throw new DiagnosticSourceCacheError(
        "The managed source cache disappeared during validation.",
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DiagnosticSourceCacheError(
        "The managed source cache must be a real directory inside Root-owned storage.",
      );
    }
  }

  private async assertOrigin(
    canonicalPath: string,
    canonicalRemote: string,
  ): Promise<void> {
    let origin: string;
    try {
      origin = await this.git({
        cwd: canonicalPath,
        args: ["remote", "get-url", "origin"],
      });
    } catch {
      throw new DiagnosticSourceCacheError(
        "The managed source cache is not a valid Root-owned Git checkout.",
      );
    }
    if (origin !== canonicalRemote) {
      throw new DiagnosticSourceCacheError(
        "The managed source cache origin does not match the canonical diagnostic repository.",
      );
    }
  }

  private async fetch(canonicalPath: string): Promise<void> {
    try {
      await this.git({
        cwd: canonicalPath,
        args: ["fetch", "--prune", "origin"],
      });
    } catch {
      throw new DiagnosticSourceCacheError(
        "Root could not fetch the canonical diagnostic source; verify host Git authentication, repository availability, and retry.",
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
      throw new DiagnosticSourceCacheError(
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
      throw new DiagnosticSourceCacheError(
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
      throw new DiagnosticSourceCacheError(
        "Root could not resolve the " +
          description +
          " in the managed source cache.",
      );
    }
    if (!isImmutableSha(resolved)) {
      throw new DiagnosticSourceCacheError(
        "Root resolved a non-immutable value for the " + description + ".",
      );
    }
    return resolved;
  }
}

/** Resolves the FailureReport repository root without accepting an external path. */
function resolveFailureReportRuntimeRoot(): string {
  const candidates = [
    dirname(fileURLToPath(import.meta.url)),
    resolve(process.cwd()),
  ];
  for (const candidate of candidates) {
    const root = findFailureReportRuntimeRoot(candidate);
    if (root) {
      return root;
    }
  }
  throw new DiagnosticSourceCacheError(
    "Unable to locate the FailureReport runtime root for `.eve/sandbox-cache`.",
  );
}

function findFailureReportRuntimeRoot(start: string): string | undefined {
  let candidate = resolve(start);
  while (true) {
    if (
      existsSync(join(candidate, "pnpm-workspace.yaml")) &&
      existsSync(join(candidate, "eve", "package.json"))
    ) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return undefined;
    }
    candidate = parent;
  }
}

async function resolveOwnedDirectory(
  paths: ManagedWorkspacePathOperations,
  parent: string,
  declaredPath: string,
  description: string,
): Promise<string> {
  try {
    await paths.ensureDirectory(declaredPath);
    const stat = await paths.lstat(declaredPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DiagnosticSourceCacheError(
        description + " must be a real directory, not a symlink or file.",
      );
    }
    const canonicalPath = await paths.realpath(declaredPath);
    if (!isPathInside(parent, canonicalPath)) {
      throw new DiagnosticSourceCacheError(
        description + " resolves outside its Root-owned parent directory.",
      );
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof DiagnosticSourceCacheError) {
      throw error;
    }
    throw new DiagnosticSourceCacheError(
      description + " cannot be created or inspected safely.",
    );
  }
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

function sourceIdentity(canonicalRemote: string): string {
  return createHash("sha256")
    .update(canonicalRemote)
    .digest("hex")
    .slice(0, 16);
}

function isImmutableSha(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
}

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Returns true only for a child path; a managed child may never equal its root. */
function isPathInside(root: string, path: string): boolean {
  const candidate = resolve(path);
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
