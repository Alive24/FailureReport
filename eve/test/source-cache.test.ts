import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { failureReportSchema } from "@failure-report/protocol";

import { DiagnosticSourceCacheManager } from "../agent/lib/diagnostics/source-cache.js";
import type {
  GitCommandRunner,
  WorktreePathOperations,
} from "../agent/lib/diagnostics/worktree.js";

const runtimeRoot = "/sandbox/failure-report";
const sandboxCacheRoot = join(runtimeRoot, ".eve", "sandbox-cache");
const sourceRoot = join(sandboxCacheRoot, "sources");
const canonicalRemote = "https://github.com/Alive24/CKBoost.git";
const baseRevision = "a".repeat(40);

describe("DiagnosticSourceCacheManager", () => {
  it("clones a Root-derived source cache beneath the fixed .eve hierarchy and verifies an immutable SHA", async () => {
    const harness = await createHarness();

    const source = await harness.manager.acquire(harness.report);

    expect(source.canonical_path).toMatch(
      /^\/sandbox\/failure-report\/\.eve\/sandbox-cache\/sources\/source-[0-9a-f]{16}$/,
    );
    expect(source.canonical_remote).toBe(canonicalRemote);
    expect(source.base_revision).toBe(baseRevision);
    expect(harness.calls).toContainEqual({
      cwd: sourceRoot,
      args: [
        "clone",
        "--no-checkout",
        "--origin",
        "origin",
        canonicalRemote,
        source.canonical_path,
      ],
    });
    expect(harness.calls).toContainEqual({
      cwd: source.canonical_path,
      args: ["fetch", "--prune", "origin"],
    });
    expect(harness.calls.some((call) => call.args[0] === "ls-remote")).toBe(
      false,
    );
  });

  it("reuses a verified persistent cache without fetching when its recorded SHA exists", async () => {
    const harness = await createHarness();
    const source = await harness.manager.acquire(harness.report);
    harness.clearCalls();

    await expect(
      harness.manager.restore(harness.report, source.base_revision),
    ).resolves.toMatchObject({
      canonical_path: source.canonical_path,
      base_revision: source.base_revision,
    });
    expect(harness.calls.some((call) => call.args[0] === "clone")).toBe(false);
    expect(harness.calls.some((call) => call.args[0] === "fetch")).toBe(false);
  });

  it("fetches once to reconstruct a recorded SHA that is absent from a reusable cache", async () => {
    const harness = await createHarness();
    const source = await harness.manager.acquire(harness.report);
    harness.removeRevision(source.base_revision);
    harness.clearCalls();

    await expect(
      harness.manager.restore(harness.report, source.base_revision),
    ).resolves.toMatchObject({ base_revision: source.base_revision });
    expect(harness.calls).toContainEqual({
      cwd: source.canonical_path,
      args: ["fetch", "--prune", "origin"],
    });
  });

  it("fails closed when a persistent cache points at a different origin", async () => {
    const harness = await createHarness();
    const source = await harness.manager.acquire(harness.report);
    harness.setOrigin(
      source.canonical_path,
      "https://github.com/other/repo.git",
    );

    await expect(harness.manager.acquire(harness.report)).rejects.toThrow(
      "origin does not match",
    );
  });

  it("rejects a cache entry that resolves through a symlink outside .eve/sandbox-cache/sources", async () => {
    const harness = await createHarness();
    const source = await harness.manager.acquire(harness.report);
    harness.paths.addDirectory("/outside/source");
    harness.paths.setLink(source.canonical_path, "/outside/source");

    await expect(harness.manager.acquire(harness.report)).rejects.toThrow(
      "resolves outside Root-owned `.eve/sandbox-cache/sources`",
    );
  });

  it("rejects a symlinked sandbox-cache ancestor before Git is invoked", async () => {
    const harness = await createHarness();
    harness.paths.addDirectory("/outside/cache");
    harness.paths.setLink(sandboxCacheRoot, "/outside/cache");

    await expect(harness.manager.acquire(harness.report)).rejects.toThrow(
      "FailureReport sandbox cache cannot be created or inspected safely",
    );
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects a report whose diagnostic repository differs from its published Issue", async () => {
    const harness = await createHarness({ repository: "Alive24/Other" });

    await expect(harness.manager.acquire(harness.report)).rejects.toThrow(
      "must exactly match",
    );
    expect(harness.calls).toHaveLength(0);
  });
});

async function createHarness(options: { repository?: string } = {}) {
  const fixture = new URL(
    "../../packages/protocol/test/fixtures/issue-54.json",
    import.meta.url,
  );
  const loaded = failureReportSchema.parse(
    JSON.parse(await readFile(fixture, "utf8")),
  );
  const issueRepository = "Alive24/CKBoost";
  const targetRepository = options.repository ?? issueRepository;
  const report = failureReportSchema.parse({
    ...loaded,
    target: {
      ...loaded.target,
      repository: targetRepository,
      revision: baseRevision,
    },
    shared_context: {
      provider: "github_issue",
      repository: issueRepository,
      issue_number: 54,
      issue_url: "https://github.com/Alive24/CKBoost/issues/54",
      workpad_marker: "<!-- failure-report-workpad -->",
      workpad_revision: 1,
    },
  });
  const paths = new FakePaths([runtimeRoot]);
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const origins = new Map<string, string>();
  const availableRevisions = new Set<string>();
  let cachePath: string | undefined;
  const git: GitCommandRunner = async ({ cwd, args }) => {
    calls.push({ cwd, args });
    if (args[0] === "clone") {
      cachePath = args.at(-1);
      const remote = args.at(-2);
      if (!cachePath || !remote) {
        throw new Error("missing clone arguments");
      }
      paths.addDirectory(cachePath);
      origins.set(cachePath, remote);
      return "";
    }
    if (args.join(" ") === "remote get-url origin") {
      const origin = origins.get(cwd);
      if (!origin) {
        throw new Error("cache has no origin");
      }
      return origin;
    }
    if (args.join(" ") === "fetch --prune origin") {
      availableRevisions.add(baseRevision);
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const requested = args[2]?.replace("^{commit}", "");
      if (requested && availableRevisions.has(requested)) {
        return requested;
      }
      throw new Error("missing revision");
    }
    throw new Error(
      "Unexpected git command: " + cwd + " git " + args.join(" "),
    );
  };
  const manager = new DiagnosticSourceCacheManager({
    runtimeRoot,
    git,
    paths,
    remoteForRepository: () => canonicalRemote,
  });

  return {
    manager,
    report,
    paths,
    calls,
    clearCalls() {
      calls.splice(0, calls.length);
    },
    removeRevision(revision: string) {
      availableRevisions.delete(revision);
    },
    setOrigin(path: string, origin: string) {
      origins.set(path, origin);
    },
    cachePath: () => cachePath,
  };
}

class FakePaths implements Pick<
  WorktreePathOperations,
  "ensureDirectory" | "lstat" | "realpath"
> {
  private readonly directories = new Set<string>();
  private readonly links = new Map<string, string>();

  constructor(paths: readonly string[]) {
    paths.forEach((path) => this.directories.add(path));
  }

  async ensureDirectory(path: string): Promise<void> {
    if (this.links.has(path)) {
      throw fileSystemError("EEXIST");
    }
    this.directories.add(path);
  }

  async realpath(path: string): Promise<string> {
    const target = this.links.get(path);
    if (target) {
      return this.realpath(target);
    }
    if (this.directories.has(path)) {
      return path;
    }
    throw fileSystemError("ENOENT");
  }

  async lstat(path: string) {
    if (this.links.has(path)) {
      return {
        isDirectory: () => false,
        isSymbolicLink: () => true,
      };
    }
    if (this.directories.has(path)) {
      return {
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    }
    throw fileSystemError("ENOENT");
  }

  addDirectory(path: string): void {
    this.links.delete(path);
    this.directories.add(path);
  }

  setLink(path: string, target: string): void {
    this.directories.delete(path);
    this.links.set(path, target);
  }
}

function fileSystemError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
