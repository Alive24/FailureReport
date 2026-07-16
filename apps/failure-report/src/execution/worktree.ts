import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ExecutionState, FailureReport } from "@failure-report/protocol";

/**
 * Deterministic, Root-owned isolated-worktree lifecycle management.
 *
 * Domain packs configure this module with their domain and backend identities,
 * but cannot pick a path, branch, or canonical checkout themselves.
 */

/** Signals that resuming or allocating an execution would violate an isolation rule. */
export class ExecutionSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionSafetyError";
  }
}

/** Injectable Git runner used to make worktree safety behavior testable. */
export type GitCommandRunner = (input: {
  cwd: string;
  args: string[];
}) => Promise<string>;

/** Injectable filesystem operations used for deterministic path and symlink checks. */
export type WorktreePathOperations = {
  ensureDirectory(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
};

/** Configuration binding a generic manager to one domain/backend execution pair. */
export type ExecutionWorktreeManagerOptions = {
  domainId: string;
  backendId: string;
  root?: string;
  git?: GitCommandRunner;
  paths?: WorktreePathOperations;
};

/** Canonical checkout plus the validated durable state for an execution worktree. */
export type VerifiedExecution = {
  canonical_path: string;
  state: ExecutionState;
};

/** Real filesystem implementation used outside tests. */
const defaultPathOperations: WorktreePathOperations = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  realpath,
};

/**
 * Allocates, restores, and inspects one deterministic isolated worktree per report.
 *
 * The manager rejects every unsafe resume instead of falling back to the canonical
 * checkout. Callers can then surface `needs_input` rather than run code elsewhere.
 */
export class ExecutionWorktreeManager {
  private readonly domainId: string;
  private readonly backendId: string;
  private readonly root: string;
  private readonly git: GitCommandRunner;
  private readonly paths: WorktreePathOperations;

  constructor(options: ExecutionWorktreeManagerOptions) {
    this.domainId = options.domainId;
    this.backendId = options.backendId;
    this.root = resolve(
      options.root ??
        process.env.FAILURE_REPORT_WORKTREE_ROOT ??
        join(homedir(), ".failure-report", "worktrees"),
    );
    this.git = options.git ?? runGit;
    this.paths = options.paths ?? defaultPathOperations;
  }

  /**
   * Creates a fresh, deterministic worktree and returns the state that must be
   * written to the workpad before a domain backend is allowed to start.
   */
  async allocate(report: FailureReport): Promise<VerifiedExecution> {
    const canonicalPath = await this.resolveCanonicalCheckout(report);
    await this.paths.ensureDirectory(this.root);
    const isolatedRoot = await this.resolveIsolatedWorktreeRoot();
    const baseRevision = await this.git({
      cwd: canonicalPath,
      args: ["rev-parse", "--verify", report.target.revision + "^{commit}"],
    });
    const worktreePath = this.worktreePath(report, isolatedRoot);
    const branch = this.branchFor(report);

    if (resolve(worktreePath) === canonicalPath) {
      throw new ExecutionSafetyError(
        "Refusing to allocate the canonical checkout as an execution worktree.",
      );
    }

    try {
      // An existing path is never silently reused: it may belong to an abandoned
      // execution or a manually created checkout with unknown provenance.
      await this.paths.realpath(worktreePath);
      throw new ExecutionSafetyError(
        "An unrecorded execution worktree already exists for this FailureReport; create an explicit new execution instead of reusing it.",
      );
    } catch (error) {
      if (error instanceof ExecutionSafetyError) {
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
      throw new ExecutionSafetyError(
        "The allocated execution worktree resolves outside the configured isolated-worktree root.",
      );
    }
    const headRevision = await this.git({
      cwd: actualPath,
      args: ["rev-parse", "HEAD"],
    });

    return {
      canonical_path: canonicalPath,
      state: {
        domain_id: this.domainId,
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
   * Validates durable state before a provider resumes an existing execution.
   * The recorded HEAD must still match so an out-of-band mutation cannot become
   * an invisible continuation of the prior agent session.
   */
  async restore(
    report: FailureReport,
    state: ExecutionState,
  ): Promise<VerifiedExecution> {
    return this.inspect(report, state, true);
  }

  /**
   * Revalidates an active worktree and captures its current HEAD at completion.
   * Unlike resume, this deliberately permits the execution itself to have moved HEAD.
   */
  async captureCurrent(
    report: FailureReport,
    state: ExecutionState,
  ): Promise<VerifiedExecution> {
    return this.inspect(report, state, false);
  }

  private async inspect(
    report: FailureReport,
    state: ExecutionState,
    requireRecordedHead: boolean,
  ): Promise<VerifiedExecution> {
    // Bind state to the selected domain/backend before inspecting filesystem data.
    if (state.domain_id !== this.domainId) {
      throw new ExecutionSafetyError(
        "Execution state belongs to a different domain: " + state.domain_id,
      );
    }
    if (state.backend_id !== this.backendId) {
      throw new ExecutionSafetyError(
        "Execution state uses an unsupported backend: " + state.backend_id,
      );
    }
    if (state.worktree.identity !== this.identityFor(report)) {
      throw new ExecutionSafetyError(
        "Execution worktree identity does not belong to this FailureReport.",
      );
    }

    const canonicalPath = await this.resolveCanonicalCheckout(report);
    const isolatedRoot = await this.resolveIsolatedWorktreeRoot();
    const declaredPath = state.worktree.path;
    if (!isAbsolute(declaredPath)) {
      throw new ExecutionSafetyError(
        "Execution worktree path must be absolute.",
      );
    }
    if (resolve(declaredPath) !== this.worktreePath(report, isolatedRoot)) {
      throw new ExecutionSafetyError(
        "Execution worktree path does not match this FailureReport's deterministic isolated-worktree identity.",
      );
    }
    if (!isPathInside(isolatedRoot, declaredPath)) {
      throw new ExecutionSafetyError(
        "Execution worktree is outside the configured isolated-worktree root.",
      );
    }

    let worktreePath: string;
    try {
      worktreePath = await this.paths.realpath(declaredPath);
    } catch {
      throw new ExecutionSafetyError(
        "The saved execution worktree no longer exists; do not fall back to the canonical checkout.",
      );
    }
    // Check the resolved path as well as the declared path to block symlink escapes.
    if (!isPathInside(isolatedRoot, worktreePath)) {
      throw new ExecutionSafetyError(
        "The saved execution worktree resolves outside the configured isolated-worktree root.",
      );
    }
    if (worktreePath === canonicalPath) {
      throw new ExecutionSafetyError(
        "The saved execution worktree resolves to the canonical checkout.",
      );
    }

    const topLevel = await this.paths.realpath(
      await this.git({
        cwd: worktreePath,
        args: ["rev-parse", "--show-toplevel"],
      }),
    );
    if (topLevel !== worktreePath) {
      throw new ExecutionSafetyError(
        "The saved execution path is not the root of its Git worktree.",
      );
    }

    const branch = await this.git({
      cwd: worktreePath,
      args: ["branch", "--show-current"],
    });
    if (branch !== state.worktree.branch) {
      throw new ExecutionSafetyError(
        "The saved execution branch no longer matches its durable state.",
      );
    }

    const headRevision = await this.git({
      cwd: worktreePath,
      args: ["rev-parse", "HEAD"],
    });
    if (requireRecordedHead && headRevision !== state.worktree.head_revision) {
      // A resume after an external mutation needs an operator decision, not a
      // best-effort replay against code the original session never observed.
      throw new ExecutionSafetyError(
        "The saved execution HEAD changed outside FailureReport; explicit operator input is required before resume.",
      );
    }

    const mergeBase = await this.git({
      cwd: worktreePath,
      args: ["merge-base", state.worktree.base_revision, headRevision],
    });
    if (mergeBase !== state.worktree.base_revision) {
      throw new ExecutionSafetyError(
        "The execution branch no longer descends from its recorded base revision.",
      );
    }

    await this.assertSameOrigin(canonicalPath, worktreePath);

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

  private async resolveCanonicalCheckout(
    report: FailureReport,
  ): Promise<string> {
    const declaredPath = report.target.worktree_identity;
    if (!isAbsolute(declaredPath)) {
      throw new ExecutionSafetyError(
        "FailureReport.target.worktree_identity must be an absolute canonical checkout path.",
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
      throw new ExecutionSafetyError(
        "FailureReport.target.worktree_identity must point at the canonical Git worktree root.",
      );
    }
    return canonicalPath;
  }

  private async resolveIsolatedWorktreeRoot(): Promise<string> {
    try {
      return await this.paths.realpath(this.root);
    } catch {
      throw new ExecutionSafetyError(
        "The configured isolated-worktree root cannot be resolved.",
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
      // still prevent a saved state from selecting an arbitrary worktree path.
      return;
    }
    const worktreeOrigin = await optionalGit(this.git, worktreePath, [
      "remote",
      "get-url",
      "origin",
    ]);
    if (worktreeOrigin !== canonicalOrigin) {
      throw new ExecutionSafetyError(
        "The saved execution worktree points at a different Git origin.",
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
          this.domainId +
          "\u0000" +
          this.backendId,
      )
      .digest("hex")
      .slice(0, 12);
    // Include domain/backend in the digest so two execution modes for one report
    // cannot collide on the same worktree and branch.
    return (
      "execution-" + this.domainId + "-" + (slug || "report") + "-" + digest
    );
  }

  private branchFor(report: FailureReport): string {
    return "failure-report/" + this.domainId + "/" + this.identityFor(report);
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

/** Narrows a filesystem error to the only expected pre-allocation absence case. */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
