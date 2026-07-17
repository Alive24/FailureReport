import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type {
  DiagnosticSession,
  FailureReport,
} from "@failure-report/protocol";

import type {
  DiagnosticDomainProfile,
  NativeSkillProfile,
} from "./domain-profiles.js";

/**
 * Deterministic, Root-owned diagnostic-worktree lifecycle management.
 *
 * Root binds this manager to an installed domain profile and backend. Neither a
 * domain extension nor a model can select a path, branch, checkout, or skill
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

/** Configuration binding a generic manager to one Root-owned diagnostic profile. */
export type DiagnosticWorktreeManagerOptions = {
  profile: DiagnosticDomainProfile;
  backendId: string;
  root?: string;
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
 * report. The manager refuses unsafe state rather than falling back to the
 * source checkout, and materializes only the profile's approved native skills.
 */
export class DiagnosticWorktreeManager {
  private readonly profile: DiagnosticDomainProfile;
  private readonly backendId: string;
  private readonly root: string;
  private readonly git: GitCommandRunner;
  private readonly paths: WorktreePathOperations;

  constructor(options: DiagnosticWorktreeManagerOptions) {
    this.profile = options.profile;
    this.backendId = options.backendId;
    this.root = resolve(
      options.root ??
        process.env.FAILURE_REPORT_WORKTREE_ROOT ??
        join(homedir(), ".failure-report", "worktrees"),
    );
    this.git = options.git ?? runGit;
    this.paths = options.paths ?? defaultPathOperations;
  }

  /** Exposes the fixed profile names for envelope validation without paths. */
  nativeSkillNames(): readonly string[] {
    return this.profile.native_skills.map((skill) => skill.name);
  }

  /** Rejects an envelope whose requested skills do not exactly match Root policy. */
  assertNativeSkillNames(names: readonly string[]): void {
    const expected = this.nativeSkillNames();
    if (
      names.length !== expected.length ||
      names.some((name, index) => name !== expected[index])
    ) {
      throw new DiagnosticSafetyError(
        "Diagnostic-session native skills do not match the Root-owned domain profile.",
      );
    }
  }

  /**
   * Creates a fresh deterministic worktree and durable state before a Codex
   * session may start. Skill sources are validated before Git mutates anything.
   */
  async allocate(report: FailureReport): Promise<VerifiedDiagnosticWorktree> {
    const canonicalPath = await this.resolveCanonicalCheckout(report);
    const nativeSkills = await this.resolveNativeSkillSources();
    await this.paths.ensureDirectory(this.root);
    const isolatedRoot = await this.resolveIsolatedWorktreeRoot();
    const baseRevision = await this.git({
      cwd: canonicalPath,
      args: ["rev-parse", "--verify", report.target.revision + "^{commit}"],
    });
    const worktreePath = this.worktreePath(report, isolatedRoot);
    const branch = this.branchFor(report);

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
      args: ["worktree", "add", "-b", branch, worktreePath, baseRevision],
    });

    const actualPath = await this.paths.realpath(worktreePath);
    // Resolve after `git worktree add` to reject a root containing hostile symlinks.
    if (!isPathInside(isolatedRoot, actualPath)) {
      throw new DiagnosticSafetyError(
        "The allocated diagnostic worktree resolves outside the configured worktree root.",
      );
    }
    await this.provisionNativeSkills(actualPath, nativeSkills);
    const headRevision = await this.git({
      cwd: actualPath,
      args: ["rev-parse", "HEAD"],
    });

    return {
      canonical_path: canonicalPath,
      state: {
        domain_id: this.profile.domain_id,
        backend_id: this.backendId,
        worktree: {
          path: actualPath,
          identity: this.identityFor(report),
          branch,
          base_revision: baseRevision,
          head_revision: headRevision,
        },
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

  private async inspect(
    report: FailureReport,
    state: DiagnosticSession,
    requireRecordedHead: boolean,
  ): Promise<VerifiedDiagnosticWorktree> {
    if (state.domain_id !== this.profile.domain_id) {
      throw new DiagnosticSafetyError(
        "Diagnostic session belongs to a different domain: " + state.domain_id,
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

    const canonicalPath = await this.resolveCanonicalCheckout(report);
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
        "Diagnostic worktree is outside the configured worktree root.",
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
        "The saved diagnostic worktree resolves outside the configured worktree root.",
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
    if (branch !== state.worktree.branch) {
      throw new DiagnosticSafetyError(
        "The saved diagnostic branch no longer matches its durable state.",
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
        "The diagnostic branch no longer descends from its recorded base revision.",
      );
    }

    await this.assertSameOrigin(canonicalPath, worktreePath);
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
    for (const skill of this.profile.native_skills) {
      if (!/^[a-z][a-z0-9-]*$/.test(skill.name) || names.has(skill.name)) {
        throw new DiagnosticSafetyError(
          "The Root-owned domain profile contains an invalid native skill name.",
        );
      }
      names.add(skill.name);
      resolved.push(await this.resolveNativeSkillSource(skill));
    }
    if (resolved.length === 0) {
      throw new DiagnosticSafetyError(
        "The Root-owned domain profile does not provide a native diagnostic skill.",
      );
    }
    return resolved;
  }

  private async resolveNativeSkillSource(
    skill: NativeSkillProfile,
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

  private async resolveCanonicalCheckout(
    report: FailureReport,
  ): Promise<string> {
    const declaredPath = report.target.source_checkout_path;
    if (!isAbsolute(declaredPath)) {
      throw new DiagnosticSafetyError(
        "FailureReport.target.source_checkout_path must be an absolute source checkout path.",
      );
    }
    const canonicalPath = await this.paths.realpath(declaredPath);
    const topLevel = await this.paths.realpath(
      await this.git({
        cwd: canonicalPath,
        args: ["rev-parse", "--show-toplevel"],
      }),
    );
    if (topLevel !== canonicalPath) {
      throw new DiagnosticSafetyError(
        "FailureReport.target.source_checkout_path must point at the source Git worktree root.",
      );
    }
    return canonicalPath;
  }

  private async resolveIsolatedWorktreeRoot(): Promise<string> {
    try {
      return await this.paths.realpath(this.root);
    } catch {
      throw new DiagnosticSafetyError(
        "The configured diagnostic-worktree root cannot be resolved.",
      );
    }
  }

  private async assertSameOrigin(
    canonicalPath: string,
    worktreePath: string,
  ): Promise<void> {
    const canonicalOrigin = await optionalGit(this.git, canonicalPath, [
      "remote",
      "get-url",
      "origin",
    ]);
    if (!canonicalOrigin) {
      // Repositories without `origin` are supported; the other identity checks
      // still prevent durable state from selecting an arbitrary worktree path.
      return;
    }
    const worktreeOrigin = await optionalGit(this.git, worktreePath, [
      "remote",
      "get-url",
      "origin",
    ]);
    if (worktreeOrigin !== canonicalOrigin) {
      throw new DiagnosticSafetyError(
        "The saved diagnostic worktree points at a different Git origin.",
      );
    }
  }

  private worktreePath(report: FailureReport, root = this.root): string {
    return join(root, this.identityFor(report));
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
          report.id +
          "\u0000" +
          this.profile.domain_id +
          "\u0000" +
          this.backendId,
      )
      .digest("hex")
      .slice(0, 12);
    return (
      "diagnostic-" +
      this.profile.domain_id +
      "-" +
      (slug || "report") +
      "-" +
      digest
    );
  }

  private branchFor(report: FailureReport): string {
    return (
      "failure-report/diagnostic/" +
      this.profile.domain_id +
      "/" +
      this.identityFor(report)
    );
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
