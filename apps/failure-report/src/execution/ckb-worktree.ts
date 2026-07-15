import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ExecutionState, FailureReport } from "@failure-report/protocol";

export const ckbCodexBackendId = "codex_app_server";

export class WorktreeSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeSafetyError";
  }
}

export type GitCommandRunner = (input: {
  cwd: string;
  args: string[];
}) => Promise<string>;

export type WorktreePathOperations = {
  ensureDirectory(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
};

export type CkbWorktreeManagerOptions = {
  root?: string;
  git?: GitCommandRunner;
  paths?: WorktreePathOperations;
};

export type VerifiedCkbExecution = {
  canonical_path: string;
  state: ExecutionState;
};

const defaultPathOperations: WorktreePathOperations = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  realpath,
};

export class CkbWorktreeManager {
  private readonly root: string;
  private readonly git: GitCommandRunner;
  private readonly paths: WorktreePathOperations;

  constructor(options: CkbWorktreeManagerOptions = {}) {
    this.root = resolve(
      options.root ??
        process.env.FAILURE_REPORT_WORKTREE_ROOT ??
        join(homedir(), ".failure-report", "worktrees"),
    );
    this.git = options.git ?? runGit;
    this.paths = options.paths ?? defaultPathOperations;
  }

  async allocate(report: FailureReport): Promise<VerifiedCkbExecution> {
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
      throw new WorktreeSafetyError(
        "Refusing to allocate the canonical checkout as a CKB execution worktree.",
      );
    }

    try {
      await this.paths.realpath(worktreePath);
      throw new WorktreeSafetyError(
        "An unrecorded worktree already exists for this FailureReport; create an explicit new execution instead of reusing it.",
      );
    } catch (error) {
      if (error instanceof WorktreeSafetyError) {
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
    if (!isPathInside(isolatedRoot, actualPath)) {
      throw new WorktreeSafetyError(
        "The allocated CKB execution worktree resolves outside the configured isolated-worktree root.",
      );
    }
    const headRevision = await this.git({
      cwd: actualPath,
      args: ["rev-parse", "HEAD"],
    });

    return {
      canonical_path: canonicalPath,
      state: {
        backend_id: ckbCodexBackendId,
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

  async restore(
    report: FailureReport,
    state: ExecutionState,
  ): Promise<VerifiedCkbExecution> {
    return this.inspect(report, state, true);
  }

  async captureCurrent(
    report: FailureReport,
    state: ExecutionState,
  ): Promise<VerifiedCkbExecution> {
    return this.inspect(report, state, false);
  }

  private async inspect(
    report: FailureReport,
    state: ExecutionState,
    requireRecordedHead: boolean,
  ): Promise<VerifiedCkbExecution> {
    if (state.backend_id !== ckbCodexBackendId) {
      throw new WorktreeSafetyError(
        "CKB execution state uses an unsupported backend: " + state.backend_id,
      );
    }
    if (state.worktree.identity !== this.identityFor(report)) {
      throw new WorktreeSafetyError(
        "CKB execution worktree identity does not belong to this FailureReport.",
      );
    }

    const canonicalPath = await this.resolveCanonicalCheckout(report);
    const isolatedRoot = await this.resolveIsolatedWorktreeRoot();
    const declaredPath = state.worktree.path;
    if (!isAbsolute(declaredPath)) {
      throw new WorktreeSafetyError(
        "CKB execution worktree path must be absolute.",
      );
    }
    if (resolve(declaredPath) !== this.worktreePath(report, isolatedRoot)) {
      throw new WorktreeSafetyError(
        "CKB execution worktree path does not match this FailureReport's deterministic isolated-worktree identity.",
      );
    }
    if (!isPathInside(isolatedRoot, declaredPath)) {
      throw new WorktreeSafetyError(
        "CKB execution worktree is outside the configured isolated-worktree root.",
      );
    }

    let worktreePath: string;
    try {
      worktreePath = await this.paths.realpath(declaredPath);
    } catch {
      throw new WorktreeSafetyError(
        "The saved CKB execution worktree no longer exists; do not fall back to the canonical checkout.",
      );
    }
    if (!isPathInside(isolatedRoot, worktreePath)) {
      throw new WorktreeSafetyError(
        "The saved CKB execution worktree resolves outside the configured isolated-worktree root.",
      );
    }
    if (worktreePath === canonicalPath) {
      throw new WorktreeSafetyError(
        "The saved CKB execution worktree resolves to the canonical checkout.",
      );
    }

    const topLevel = await this.paths.realpath(
      await this.git({
        cwd: worktreePath,
        args: ["rev-parse", "--show-toplevel"],
      }),
    );
    if (topLevel !== worktreePath) {
      throw new WorktreeSafetyError(
        "The saved CKB execution path is not the root of its Git worktree.",
      );
    }

    const branch = await this.git({
      cwd: worktreePath,
      args: ["branch", "--show-current"],
    });
    if (branch !== state.worktree.branch) {
      throw new WorktreeSafetyError(
        "The saved CKB execution branch no longer matches its durable state.",
      );
    }

    const headRevision = await this.git({
      cwd: worktreePath,
      args: ["rev-parse", "HEAD"],
    });
    if (requireRecordedHead && headRevision !== state.worktree.head_revision) {
      throw new WorktreeSafetyError(
        "The saved CKB execution HEAD changed outside FailureReport; explicit operator input is required before resume.",
      );
    }

    const mergeBase = await this.git({
      cwd: worktreePath,
      args: ["merge-base", state.worktree.base_revision, headRevision],
    });
    if (mergeBase !== state.worktree.base_revision) {
      throw new WorktreeSafetyError(
        "The CKB execution branch no longer descends from its recorded base revision.",
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
      throw new WorktreeSafetyError(
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
      throw new WorktreeSafetyError(
        "FailureReport.target.worktree_identity must point at the canonical Git worktree root.",
      );
    }
    return canonicalPath;
  }

  private async resolveIsolatedWorktreeRoot(): Promise<string> {
    try {
      return await this.paths.realpath(this.root);
    } catch {
      throw new WorktreeSafetyError(
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
      return;
    }
    const worktreeOrigin = await optionalGit(this.git, worktreePath, [
      "remote",
      "get-url",
      "origin",
    ]);
    if (worktreeOrigin !== canonicalOrigin) {
      throw new WorktreeSafetyError(
        "The saved CKB execution worktree points at a different Git origin.",
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
      .update(report.target.repository + "\u0000" + report.id)
      .digest("hex")
      .slice(0, 12);
    return "ckb-" + (slug || "report") + "-" + digest;
  }

  private branchFor(report: FailureReport): string {
    return "failure-report/" + this.identityFor(report);
  }
}

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
