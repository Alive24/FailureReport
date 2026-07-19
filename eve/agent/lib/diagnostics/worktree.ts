import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, symlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  DiagnosticSession,
  FailureReport,
} from "@failure-report/protocol";

import type { DomainExtension, NativeSkill } from "./domain-extensions.js";
import {
  DiagnosticSourceCacheError,
  DiagnosticSourceCacheManager,
  resolveManagedDiagnosticWorkspaceLayout,
  type DiagnosticSourceResolver,
  type ResolvedDiagnosticSource,
} from "./source-cache.js";

/**
 * Deterministic, Root-owned diagnostic-worktree lifecycle management.
 *
 * Root binds this manager to an installed extension set and backend. Neither a
 * domain extension nor a model can select a path, checkout, or skill
 * source. Codex only receives the resulting worktree as its current directory.
 */

/** Signals that preparing or resuming a diagnostic session would violate isolation. */
export class DiagnosticSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticSafetyError";
  }
}

/** Injectable Git runner used to make worktree safety behavior testable. */
export type GitCommandRunner = (input: {
  cwd: string;
  args: string[];
}) => Promise<string>;

/** Minimal stat shape needed to fail closed on a worktree-local skill conflict. */
export type WorktreePathStat = {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
};

/** Injectable filesystem operations used for deterministic path and symlink checks. */
export type WorktreePathOperations = {
  ensureDirectory(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<WorktreePathStat>;
  symlink(target: string, path: string): Promise<void>;
};

/** Configuration binding a generic manager to Root-owned extension capabilities. */
export type DiagnosticWorktreeManagerOptions = {
  domainExtensions: readonly DomainExtension[];
  backendId: string;
  /** Authored host-runtime seam; callers can never provide a workspace path. */
  runtimeRoot?: string;
  sourceCache?: DiagnosticSourceResolver;
  git?: GitCommandRunner;
  paths?: WorktreePathOperations;
};

/** Canonical checkout plus the validated durable state for a diagnostic worktree. */
export type VerifiedDiagnosticWorktree = {
  canonical_path: string;
  state: DiagnosticSession;
};

type ResolvedNativeSkill = {
  name: string;
  source_directory: string;
};

/** Real filesystem implementation used outside tests. */
const defaultPathOperations: WorktreePathOperations = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  realpath,
  lstat,
  async symlink(target, path) {
    await symlink(target, path, "dir");
  },
};

/**
 * Allocates, restores, and inspects one deterministic diagnostic worktree per
 * report. The manager refuses unsafe state rather than falling back to an
 * arbitrary checkout, and materializes only selected extensions' approved
 * native skills.
 */
export class DiagnosticWorktreeManager {
  private readonly domainExtensions: readonly DomainExtension[];
  private readonly backendId: string;
  private readonly runtimeRoot?: string;
  private readonly git: GitCommandRunner;
  private readonly paths: WorktreePathOperations;
  private readonly sourceCache: DiagnosticSourceResolver;

  constructor(options: DiagnosticWorktreeManagerOptions) {
    this.domainExtensions = [...options.domainExtensions];
    this.assertDomainExtensions();
    this.backendId = options.backendId;
    this.runtimeRoot = options.runtimeRoot;
    this.git = options.git ?? runGit;
    this.paths = options.paths ?? defaultPathOperations;
    this.sourceCache =
      options.sourceCache ??
      new DiagnosticSourceCacheManager({
        runtimeRoot: this.runtimeRoot,
        git: this.git,
        paths: this.paths,
      });
  }

  /** Exposes the fixed extension skill names for envelope validation without paths. */
  nativeSkillNames(): readonly string[] {
    return this.domainExtensions
      .flatMap((extension) =>
        extension.native_skills.map((skill) => skill.name),
      )
      .sort();
  }

  /** Rejects an envelope whose requested skills do not exactly match Root policy. */
  assertNativeSkillNames(names: readonly string[]): void {
    const expected = this.nativeSkillNames();
    if (
      names.length !== expected.length ||
      names.some((name, index) => name !== expected[index])
    ) {
      throw new DiagnosticSafetyError(
        "Diagnostic-session native skills do not match the Root-owned domain extensions.",
      );
    }
  }

  /**
   * Creates a fresh deterministic worktree and durable state before a Codex
   * session may start. Skill sources are validated before Git mutates anything.
   */
  async allocate(
    report: FailureReport,
    diagnosticBranchSlug: string,
  ): Promise<VerifiedDiagnosticWorktree> {
    this.assertDiagnosticBranchSlug(diagnosticBranchSlug);
    const source = await this.acquireCanonicalSource(report);
    const canonicalPath = source.canonical_path;
    const nativeSkills = await this.resolveNativeSkillSources();
    const isolatedRoot = await this.resolveIsolatedWorktreeRoot();
    const baseRevision = source.base_revision;
    const worktreePath = this.worktreePath(report, isolatedRoot);

    if (resolve(worktreePath) === canonicalPath) {
      throw new DiagnosticSafetyError(
        "Refusing to allocate the source checkout as a diagnostic worktree.",
      );
    }

    try {
      // An existing path is never silently reused: it may belong to an abandoned
      // session or a manually created checkout with unknown provenance.
      await this.paths.realpath(worktreePath);
      throw new DiagnosticSafetyError(
        "An unrecorded diagnostic worktree already exists for this FailureReport; explicit operator input is required before reuse.",
      );
    } catch (error) {
      if (error instanceof DiagnosticSafetyError) {
        throw error;
      }
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    await this.git({
      cwd: canonicalPath,
      args: ["worktree", "add", "--detach", worktreePath, baseRevision],
    });

    const allocatedStat = await this.paths.lstat(worktreePath);
    if (allocatedStat.isSymbolicLink() || !allocatedStat.isDirectory()) {
      throw new DiagnosticSafetyError(
        "The allocated diagnostic worktree must be a real directory, not a symlink or file.",
      );
    }
    const actualPath = await this.paths.realpath(worktreePath);
    // Resolve after `git worktree add` to reject a root containing hostile symlinks.
    if (!isPathInside(isolatedRoot, actualPath)) {
      throw new DiagnosticSafetyError(
        "The allocated diagnostic worktree resolves outside Root-owned `.eve/sandbox-cache/worktrees`.",
      );
    }
    await this.provisionNativeSkills(actualPath, nativeSkills);
    const headRevision = await this.git({
      cwd: actualPath,
      args: ["rev-parse", "HEAD"],
    });
    await this.assertSameOrigin(source.canonical_remote, actualPath);

    return {
      canonical_path: canonicalPath,
      state: {
        lifecycle: "active",
        domain_extensions: this.domainExtensionIds(),
        backend_id: this.backendId,
        worktree: {
          path: actualPath,
          identity: this.identityFor(report),
          base_revision: baseRevision,
          head_revision: headRevision,
        },
        diagnostic_branch_slug: diagnosticBranchSlug,
      },
    };
  }

  /**
   * Validates durable state before Codex resumes an existing diagnostic session.
   * A changed saved HEAD indicates out-of-band mutation and requires input.
   */
  async restore(
    report: FailureReport,
    state: DiagnosticSession,
  ): Promise<VerifiedDiagnosticWorktree> {
    return this.inspect(report, state, true);
  }

  /**
   * Rehomes one narrowly defined historical session whose old Root runtime no
   * longer owns its persisted worktree path. The old directory is never read,
   * reused, or removed: only an unchanged immutable target revision may be
   * reconstructed under the current Root-owned worktree root.
   */
  async rehydrateLegacyRuntimeWorktree(
    report: FailureReport,
    state: DiagnosticSession,
  ): Promise<VerifiedDiagnosticWorktree> {
    if (state.lifecycle !== "active") {
      throw new DiagnosticSafetyError(
        "Only an active diagnostic session can be rehomed from a legacy Root runtime.",
      );
    }
    if (!sameStrings(state.domain_extensions, this.domainExtensionIds())) {
      throw new DiagnosticSafetyError(
        "Legacy diagnostic session belongs to a different Root-owned domain extension set.",
      );
    }
    if (state.backend_id !== this.backendId) {
      throw new DiagnosticSafetyError(
        "Legacy diagnostic session uses an unsupported backend: " +
          state.backend_id,
      );
    }
    const identity = this.identityFor(report);
    if (state.worktree.identity !== identity) {
      throw new DiagnosticSafetyError(
        "Legacy diagnostic worktree identity does not belong to this FailureReport.",
      );
    }
    if (
      !sameRevision(state.worktree.base_revision, report.target.revision) ||
      !sameRevision(state.worktree.head_revision, state.worktree.base_revision)
    ) {
      throw new DiagnosticSafetyError(
        "Legacy diagnostic worktree rehydration requires an unchanged recorded target revision.",
      );
    }

    const isolatedRoot = await this.resolveIsolatedWorktreeRoot();
    const expectedPath = this.worktreePath(report, isolatedRoot);
    const declaredPath = state.worktree.path;
    if (
      !isLegacyRuntimeWorktreePath(declaredPath, identity) ||
      resolve(declaredPath) === expectedPath
    ) {
      throw new DiagnosticSafetyError(
        "Diagnostic worktree is not an eligible legacy Root-runtime path for rehydration.",
      );
    }

    const rehydrated = await this.allocate(
      report,
      state.diagnostic_branch_slug,
    );
    const { codex_thread_id: _legacyThread, ...durableState } = state;
    return {
      ...rehydrated,
      state: {
        ...durableState,
        worktree: rehydrated.state.worktree,
      },
    };
  }

  /**
   * Revalidates an active worktree and captures its current HEAD after a turn.
   * A diagnostic may create test/cache/debug artifacts, so completion deliberately
   * captures rather than rejects a HEAD moved by the assigned Codex session.
   */
  async captureCurrent(
    report: FailureReport,
    state: DiagnosticSession,
  ): Promise<VerifiedDiagnosticWorktree> {
    return this.inspect(report, state, false);
  }

  /**
   * Creates the diagnostic-only branch after an explicit Root finalization.
   *
   * The active worktree remains detached. A pre-existing branch is acceptable
   * only when it already names this exact snapshot, which makes recovery after
   * a branch-write/workpad-write interruption safe without force-moving refs.
   */
  async finalize(
    report: FailureReport,
    state: DiagnosticSession,
    finalizedAt: string,
  ): Promise<VerifiedDiagnosticWorktree> {
    const verified = await this.inspect(report, state, true);
    const worktreePath = verified.state.worktree.path;
    const porcelain = await this.git({
      cwd: worktreePath,
      args: ["status", "--porcelain", "--untracked-files=all"],
    });
    const unexpectedChanges = porcelain
      .split("\n")
      .filter(Boolean)
      .filter((entry) => !this.isManagedSkillStatusEntry(entry));
    if (unexpectedChanges.length > 0) {
      throw new DiagnosticSafetyError(
        "Diagnostic worktree must be clean before finalization; persist or remove diagnostic artifacts before creating a snapshot branch.",
      );
    }

    const branch = this.branchFor(report, verified.state);
    const remoteRef = "refs/heads/" + branch;
    const headRevision = verified.state.worktree.head_revision;
    const remoteHead = await this.remoteBranchHead(worktreePath, remoteRef);
    if (remoteHead && remoteHead !== headRevision) {
      throw new DiagnosticSafetyError(
        "The remote diagnostic snapshot branch already points at a different revision; explicit operator input is required.",
      );
    }
    const existingHead = await optionalGit(this.git, worktreePath, [
      "rev-parse",
      "--verify",
      "refs/heads/" + branch + "^{commit}",
    ]);
    if (existingHead) {
      if (existingHead !== headRevision) {
        throw new DiagnosticSafetyError(
          "The diagnostic snapshot branch already points at a different revision; explicit operator input is required.",
        );
      }
    } else {
      await this.git({
        cwd: worktreePath,
        args: ["branch", branch, headRevision],
      });
    }
    try {
      await this.git({
        cwd: worktreePath,
        args: ["push", "origin", remoteRef + ":" + remoteRef],
      });
    } catch (error) {
      throw new DiagnosticSafetyError(
        "Unable to push the diagnostic snapshot branch without force: " +
          errorMessage(error),
      );
    }
    const pushedHead = await this.remoteBranchHead(worktreePath, remoteRef);
    if (pushedHead !== headRevision) {
      throw new DiagnosticSafetyError(
        "The remote diagnostic snapshot branch did not resolve to the finalized diagnostic HEAD.",
      );
    }

    return {
      ...verified,
      state: {
        ...verified.state,
        lifecycle: "finalized",
        diagnostic_branch: {
          name: branch,
          head_revision: headRevision,
          remote_name: "origin",
          remote_ref: remoteRef,
          remote_url: this.branchUrlFor(report, branch),
          pushed_at: finalizedAt,
          finalized_at: finalizedAt,
          reuse_policy: "diagnostic_snapshot_only",
        },
      },
    };
  }

  private async inspect(
    report: FailureReport,
    state: DiagnosticSession,
    requireRecordedHead: boolean,
  ): Promise<VerifiedDiagnosticWorktree> {
    if (state.lifecycle !== "active") {
      throw new DiagnosticSafetyError(
        "Diagnostic session is finalized and cannot be resumed as an active diagnosis.",
      );
    }
    if (!sameStrings(state.domain_extensions, this.domainExtensionIds())) {
      throw new DiagnosticSafetyError(
        "Diagnostic session belongs to a different Root-owned domain extension set.",
      );
    }
    if (state.backend_id !== this.backendId) {
      throw new DiagnosticSafetyError(
        "Diagnostic session uses an unsupported backend: " + state.backend_id,
      );
    }
    if (state.worktree.identity !== this.identityFor(report)) {
      throw new DiagnosticSafetyError(
        "Diagnostic worktree identity does not belong to this FailureReport.",
      );
    }

    const source = await this.restoreCanonicalSource(
      report,
      state.worktree.base_revision,
    );
    const canonicalPath = source.canonical_path;
    const nativeSkills = await this.resolveNativeSkillSources();
    const isolatedRoot = await this.resolveIsolatedWorktreeRoot();
    const declaredPath = state.worktree.path;
    if (!isAbsolute(declaredPath)) {
      throw new DiagnosticSafetyError(
        "Diagnostic worktree path must be absolute.",
      );
    }
    if (resolve(declaredPath) !== this.worktreePath(report, isolatedRoot)) {
      throw new DiagnosticSafetyError(
        "Diagnostic worktree path does not match this FailureReport's deterministic worktree identity.",
      );
    }
    if (!isPathInside(isolatedRoot, declaredPath)) {
      throw new DiagnosticSafetyError(
        "Diagnostic worktree is outside Root-owned `.eve/sandbox-cache/worktrees`.",
      );
    }

    let declaredStat: WorktreePathStat;
    try {
      declaredStat = await this.paths.lstat(declaredPath);
    } catch {
      throw new DiagnosticSafetyError(
        "The saved diagnostic worktree no longer exists; do not fall back to the source checkout.",
      );
    }
    if (declaredStat.isSymbolicLink() || !declaredStat.isDirectory()) {
      throw new DiagnosticSafetyError(
        "The saved diagnostic worktree must be a real directory, not a symlink or file.",
      );
    }

    let worktreePath: string;
    try {
      worktreePath = await this.paths.realpath(declaredPath);
    } catch {
      throw new DiagnosticSafetyError(
        "The saved diagnostic worktree no longer exists; do not fall back to the source checkout.",
      );
    }
    if (!isPathInside(isolatedRoot, worktreePath)) {
      throw new DiagnosticSafetyError(
        "The saved diagnostic worktree resolves outside Root-owned `.eve/sandbox-cache/worktrees`.",
      );
    }
    if (worktreePath === canonicalPath) {
      throw new DiagnosticSafetyError(
        "The saved diagnostic worktree resolves to the source checkout.",
      );
    }

    const topLevel = await this.paths.realpath(
      await this.git({
        cwd: worktreePath,
        args: ["rev-parse", "--show-toplevel"],
      }),
    );
    if (topLevel !== worktreePath) {
      throw new DiagnosticSafetyError(
        "The saved diagnostic path is not the root of its Git worktree.",
      );
    }

    const branch = await this.git({
      cwd: worktreePath,
      args: ["branch", "--show-current"],
    });
    if (branch) {
      throw new DiagnosticSafetyError(
        "The active diagnostic worktree must remain detached.",
      );
    }

    const headRevision = await this.git({
      cwd: worktreePath,
      args: ["rev-parse", "HEAD"],
    });
    if (requireRecordedHead && headRevision !== state.worktree.head_revision) {
      throw new DiagnosticSafetyError(
        "The saved diagnostic HEAD changed outside FailureReport; explicit operator input is required before resume.",
      );
    }

    const mergeBase = await this.git({
      cwd: worktreePath,
      args: ["merge-base", state.worktree.base_revision, headRevision],
    });
    if (mergeBase !== state.worktree.base_revision) {
      throw new DiagnosticSafetyError(
        "The diagnostic worktree no longer descends from its recorded base revision.",
      );
    }

    await this.assertSameOrigin(source.canonical_remote, worktreePath);
    await this.provisionNativeSkills(worktreePath, nativeSkills);

    return {
      canonical_path: canonicalPath,
      state: {
        ...state,
        worktree: {
          ...state.worktree,
          path: worktreePath,
          head_revision: headRevision,
        },
      },
    };
  }

  /** Resolves and validates all package-owned skill source directories. */
  private async resolveNativeSkillSources(): Promise<ResolvedNativeSkill[]> {
    const names = new Set<string>();
    const resolved: ResolvedNativeSkill[] = [];
    for (const skill of this.nativeSkills()) {
      if (!/^[a-z][a-z0-9-]*$/.test(skill.name) || names.has(skill.name)) {
        throw new DiagnosticSafetyError(
          "The Root-owned domain extension set contains an invalid native skill name.",
        );
      }
      names.add(skill.name);
      resolved.push(await this.resolveNativeSkillSource(skill));
    }
    if (resolved.length === 0) {
      throw new DiagnosticSafetyError(
        "The Root-owned domain extension set does not provide a native diagnostic skill.",
      );
    }
    return resolved;
  }

  private async resolveNativeSkillSource(
    skill: NativeSkill,
  ): Promise<ResolvedNativeSkill> {
    if (!isAbsolute(skill.source_root) || !isAbsolute(skill.source_directory)) {
      throw new DiagnosticSafetyError(
        "The Root-owned native skill source must use absolute package paths: " +
          skill.name,
      );
    }
    let sourceRoot: string;
    let sourceDirectory: string;
    try {
      sourceRoot = await this.paths.realpath(skill.source_root);
      sourceDirectory = await this.paths.realpath(skill.source_directory);
    } catch {
      throw new DiagnosticSafetyError(
        "The Root-owned native skill source is missing: " + skill.name,
      );
    }
    if (!isPathInsideOrEqual(sourceRoot, sourceDirectory)) {
      throw new DiagnosticSafetyError(
        "The Root-owned native skill source resolves outside its extension package: " +
          skill.name,
      );
    }
    const sourceStat = await this.paths.lstat(sourceDirectory);
    if (!sourceStat.isDirectory()) {
      throw new DiagnosticSafetyError(
        "The Root-owned native skill source is not a directory: " + skill.name,
      );
    }

    let skillManifest: string;
    try {
      skillManifest = await this.paths.realpath(
        join(sourceDirectory, "SKILL.md"),
      );
    } catch {
      throw new DiagnosticSafetyError(
        "The Root-owned native skill source has no SKILL.md: " + skill.name,
      );
    }
    if (!isPathInsideOrEqual(sourceDirectory, skillManifest)) {
      throw new DiagnosticSafetyError(
        "The Root-owned native skill manifest resolves outside its skill directory: " +
          skill.name,
      );
    }
    return { name: skill.name, source_directory: sourceDirectory };
  }

  /** Creates or verifies the one profile-owned symlink in a diagnostic worktree. */
  private async provisionNativeSkills(
    worktreePath: string,
    skills: readonly ResolvedNativeSkill[],
  ): Promise<void> {
    const agentsDirectory = join(worktreePath, ".agents");
    const skillsDirectory = join(agentsDirectory, "skills");
    try {
      await this.paths.ensureDirectory(agentsDirectory);
      const actualAgentsDirectory = await this.paths.realpath(agentsDirectory);
      if (!isPathInsideOrEqual(worktreePath, actualAgentsDirectory)) {
        throw new DiagnosticSafetyError(
          "The diagnostic worktree .agents directory resolves outside the assigned worktree.",
        );
      }
      await this.paths.ensureDirectory(skillsDirectory);
      const actualSkillsDirectory = await this.paths.realpath(skillsDirectory);
      if (!isPathInsideOrEqual(worktreePath, actualSkillsDirectory)) {
        throw new DiagnosticSafetyError(
          "The diagnostic worktree .agents/skills directory resolves outside the assigned worktree.",
        );
      }
      for (const skill of skills) {
        await this.provisionNativeSkill(actualSkillsDirectory, skill);
      }
    } catch (error) {
      if (error instanceof DiagnosticSafetyError) {
        throw error;
      }
      throw new DiagnosticSafetyError(
        "Unable to provision the Root-owned native diagnostic skill: " +
          errorMessage(error),
      );
    }
  }

  private async provisionNativeSkill(
    skillsDirectory: string,
    skill: ResolvedNativeSkill,
  ): Promise<void> {
    const linkPath = join(skillsDirectory, skill.name);
    try {
      const existing = await this.paths.lstat(linkPath);
      if (!existing.isSymbolicLink()) {
        throw new DiagnosticSafetyError(
          "The diagnostic worktree already contains a non-symlink native skill entry: " +
            skill.name,
        );
      }
    } catch (error) {
      if (error instanceof DiagnosticSafetyError) {
        throw error;
      }
      if (!isNotFoundError(error)) {
        throw error;
      }
      // Only a missing entry is repaired. A wrong link or ordinary file is never
      // overwritten because it may be meaningful target-repository content.
      await this.paths.symlink(skill.source_directory, linkPath);
    }

    let linkedSource: string;
    try {
      linkedSource = await this.paths.realpath(linkPath);
    } catch {
      throw new DiagnosticSafetyError(
        "The native skill symlink is broken: " + skill.name,
      );
    }
    if (linkedSource !== skill.source_directory) {
      throw new DiagnosticSafetyError(
        "The native skill symlink points at an unexpected source: " +
          skill.name,
      );
    }
  }

  private async acquireCanonicalSource(
    report: FailureReport,
  ): Promise<ResolvedDiagnosticSource> {
    return this.wrapSourceCache(() => this.sourceCache.acquire(report));
  }

  private async restoreCanonicalSource(
    report: FailureReport,
    recordedBaseRevision: string,
  ): Promise<ResolvedDiagnosticSource> {
    return this.wrapSourceCache(() =>
      this.sourceCache.restore(report, recordedBaseRevision),
    );
  }

  private async wrapSourceCache(
    operation: () => Promise<ResolvedDiagnosticSource>,
  ): Promise<ResolvedDiagnosticSource> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DiagnosticSourceCacheError) {
        throw new DiagnosticSafetyError(error.message);
      }
      throw error;
    }
  }

  private async resolveIsolatedWorktreeRoot(): Promise<string> {
    try {
      return (
        await resolveManagedDiagnosticWorkspaceLayout({
          runtimeRoot: this.runtimeRoot,
          paths: this.paths,
        })
      ).worktree_root;
    } catch {
      throw new DiagnosticSafetyError(
        "Root's `.eve/sandbox-cache/worktrees` directory cannot be resolved safely.",
      );
    }
  }

  private async assertSameOrigin(
    canonicalRemote: string,
    worktreePath: string,
  ): Promise<void> {
    const worktreeOrigin = await optionalGit(this.git, worktreePath, [
      "remote",
      "get-url",
      "origin",
    ]);
    if (worktreeOrigin !== canonicalRemote) {
      throw new DiagnosticSafetyError(
        "The diagnostic worktree origin does not match Root's canonical managed source.",
      );
    }
  }

  private worktreePath(report: FailureReport, root: string): string {
    return join(root, this.identityFor(report));
  }

  private domainExtensionIds(): string[] {
    return this.domainExtensions.map((extension) => extension.id);
  }

  private nativeSkills(): readonly NativeSkill[] {
    return this.domainExtensions
      .flatMap((extension) => [...extension.native_skills])
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Allows only Root-created, untracked native-skill links through the clean
   * snapshot gate. `git status --untracked-files=all` makes each link visible,
   * so every other untracked or modified target-repository path still blocks
   * finalization.
   */
  private isManagedSkillStatusEntry(entry: string): boolean {
    if (!entry.startsWith("?? ")) {
      return false;
    }
    const path = entry.slice(3);
    return this.nativeSkillNames().some(
      (name) => path === ".agents/skills/" + name,
    );
  }

  private assertDomainExtensions(): void {
    const ids = this.domainExtensionIds();
    if (
      ids.length === 0 ||
      ids.some(
        (id, index) =>
          !/^[a-z][a-z0-9_-]*$/.test(id) ||
          (index > 0 && ids[index - 1]! >= id),
      )
    ) {
      throw new DiagnosticSafetyError(
        "Root-owned domain extensions must be non-empty, unique, and sorted.",
      );
    }
  }

  private identityFor(report: FailureReport): string {
    const slug = report.id
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const digest = createHash("sha256")
      .update(
        report.target.repository +
          "\u0000" +
          report.target.revision +
          "\u0000" +
          report.id +
          "\u0000" +
          this.domainExtensionIds().join("\u0000"),
      )
      .digest("hex")
      .slice(0, 12);
    return "diagnostic-" + (slug || "report") + "-" + digest;
  }

  private branchFor(report: FailureReport, state: DiagnosticSession): string {
    const issueNumber = report.shared_context?.issue_number;
    if (!issueNumber) {
      throw new DiagnosticSafetyError(
        "Diagnostic snapshot branching requires a Root-published GitHub Issue context.",
      );
    }
    return (
      "diagnostic/" + String(issueNumber) + "-" + state.diagnostic_branch_slug
    );
  }

  private branchUrlFor(report: FailureReport, branch: string): string {
    const issue = report.shared_context;
    if (!issue) {
      throw new DiagnosticSafetyError(
        "Diagnostic snapshot publishing requires a Root-published GitHub Issue context.",
      );
    }
    const issueSuffix = "/issues/" + String(issue.issue_number);
    if (!issue.issue_url.endsWith(issueSuffix)) {
      throw new DiagnosticSafetyError(
        "Diagnostic snapshot publishing requires a canonical GitHub Issue URL.",
      );
    }
    return (
      issue.issue_url.slice(0, -issueSuffix.length) +
      "/tree/" +
      branch.split("/").map(encodeURIComponent).join("/")
    );
  }

  private async remoteBranchHead(
    worktreePath: string,
    remoteRef: string,
  ): Promise<string | undefined> {
    let output: string;
    try {
      output = await this.git({
        cwd: worktreePath,
        args: ["ls-remote", "--heads", "origin", remoteRef],
      });
    } catch (error) {
      throw new DiagnosticSafetyError(
        "Unable to inspect the remote diagnostic snapshot branch: " +
          errorMessage(error),
      );
    }
    if (!output) {
      return undefined;
    }
    const [revision, ref] = output.split(/\s+/, 2);
    if (
      !revision ||
      ref !== remoteRef ||
      !/^[0-9a-f]{40,64}$/i.test(revision)
    ) {
      throw new DiagnosticSafetyError(
        "The remote diagnostic snapshot branch returned an invalid Git reference.",
      );
    }
    return revision;
  }

  private assertDiagnosticBranchSlug(slug: string): void {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}-]{0,79}$/u.test(slug)) {
      throw new DiagnosticSafetyError(
        "Diagnostic branch slug must be a non-empty safe Issue-title slug.",
      );
    }
  }
}

/** Executes Git without a shell so configured paths and arguments stay literal. */
async function runGit(input: { cwd: string; args: string[] }): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", ["-C", input.cwd, ...input.args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }
      const message = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new Error(
          "git " +
            input.args.join(" ") +
            " failed in " +
            input.cwd +
            ": " +
            message,
        ),
      );
    });
  });
}

/** Treats a missing optional Git value, such as `origin`, as absent rather than fatal. */
async function optionalGit(
  git: GitCommandRunner,
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  try {
    return await git({ cwd, args });
  } catch {
    return undefined;
  }
}

/** Returns true only for a child path; the isolation root itself is never a worktree. */
function isPathInside(root: string, path: string): boolean {
  const candidate = resolve(path);
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

/** Returns true for a root itself or a child path. */
function isPathInsideOrEqual(root: string, path: string): boolean {
  return resolve(root) === resolve(path) || isPathInside(root, path);
}

/** Compares already-canonical Root-owned identifier lists without coercion. */
function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** Compares immutable Git object identities without treating case as meaningful. */
function sameRevision(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Recognizes a former Root-owned worktree layout without trusting its contents. */
function isLegacyRuntimeWorktreePath(path: string, identity: string): boolean {
  if (!isAbsolute(path)) {
    return false;
  }
  const expectedSuffix = join(".eve", "sandbox-cache", "worktrees", identity);
  return resolve(path).endsWith(sep + expectedSuffix);
}

/** Narrows a filesystem error to the only expected absence case. */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Converts a caught setup error into bounded operator-facing diagnostic context. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown filesystem error";
}
