import { lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DiagnosticTargetWorkspaceManager,
  readTargetWorkspace,
} from "../agent/lib/diagnostics/target-workspace.js";
import type { GitCommandRunner } from "../agent/lib/diagnostics/worktree.js";

const canonicalRemote = "https://github.com/Alive24/CKBoost.git";
const baseRevision = "a".repeat(40);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("DiagnosticTargetWorkspaceManager", () => {
  it("uses only the process-bound canonical checkout and verifies the immutable SHA", async () => {
    const harness = await createHarness();

    const source = await harness.manager.acquire(reportIdentity());

    expect(source).toEqual({
      canonical_path: harness.target,
      canonical_remote: canonicalRemote,
      base_revision: baseRevision,
    });
    expect(harness.calls).toContainEqual({
      cwd: harness.target,
      args: ["fetch", "--prune", "origin"],
    });
    expect(harness.calls.some((call) => call.args[0] === "clone")).toBe(false);
  });

  it("preflights top-level, origin, and fetch authority without guessing an Issue revision", async () => {
    const harness = await createHarness();

    await expect(harness.manager.preflight()).resolves.toEqual({
      canonical_path: harness.target,
      canonical_remote: canonicalRemote,
    });
    expect(harness.calls).toEqual([
      { cwd: harness.target, args: ["rev-parse", "--show-toplevel"] },
      { cwd: harness.target, args: ["remote", "get-url", "origin"] },
      { cwd: harness.target, args: ["fetch", "--prune", "origin"] },
    ]);
    expect(
      harness.calls.some(
        (call) => call.args[0] === "rev-parse" && call.args[1] === "--verify",
      ),
    ).toBe(false);
  });

  it("retains a redacted Git-fetch category", async () => {
    const harness = await createHarness({ fetchFails: true });

    await expect(harness.manager.preflight()).rejects.toMatchObject({
      category: "git_fetch_failed",
    });
  });

  it("restores an available recorded SHA without fetching", async () => {
    const harness = await createHarness({ revisionAvailable: true });

    await expect(
      harness.manager.restore(reportIdentity(), baseRevision),
    ).resolves.toMatchObject({
      canonical_path: harness.target,
      base_revision: baseRevision,
    });
    expect(harness.calls.some((call) => call.args[0] === "fetch")).toBe(false);
  });

  it("fetches once when the recorded SHA is absent locally", async () => {
    const harness = await createHarness();

    await expect(
      harness.manager.restore(reportIdentity(), baseRevision),
    ).resolves.toMatchObject({ base_revision: baseRevision });
    expect(harness.calls).toContainEqual({
      cwd: harness.target,
      args: ["fetch", "--prune", "origin"],
    });
  });

  it("rejects a report whose repository differs from its published Issue", async () => {
    const harness = await createHarness();

    await expect(
      harness.manager.acquire(
        reportIdentity({
          targetRepository: "Alive24/Other",
        }),
      ),
    ).rejects.toThrow("must exactly match");
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects a bound checkout with the wrong origin", async () => {
    const harness = await createHarness({
      origin: "https://github.com/other/repository.git",
    });

    await expect(harness.manager.acquire(reportIdentity())).rejects.toThrow(
      "origin does not match",
    );
  });

  it("requires the binding to be the real Git top level", async () => {
    const harness = await createHarness({ gitTopLevel: tmpdir() });

    await expect(harness.manager.acquire(reportIdentity())).rejects.toThrow(
      "Git top-level",
    );
  });

  it("rejects a non-Git target before fetch or revision work", async () => {
    const harness = await createHarness({ nonGit: true });

    await expect(harness.manager.preflight()).rejects.toMatchObject({
      category: "target_workspace_invalid",
    });
    expect(harness.calls).toHaveLength(1);
  });

  it("rejects a symlink binding before Git is invoked", async () => {
    const harness = await createHarness();
    const link = join(await temporaryDirectory(), "target-link");
    await symlink(harness.target, link);
    const manager = new DiagnosticTargetWorkspaceManager({
      targetWorkspace: link,
      git: harness.git,
      paths: { lstat, realpath },
      remoteForRepository: () => canonicalRemote,
    });

    await expect(manager.acquire(reportIdentity())).rejects.toThrow(
      "real directory",
    );
  });

  it("requires one absolute process-level target workspace", () => {
    expect(() => readTargetWorkspace({})).toThrow(
      "FAILURE_REPORT_TARGET_WORKSPACE is required",
    );
    expect(() =>
      readTargetWorkspace({
        FAILURE_REPORT_TARGET_WORKSPACE: "../CKBoost",
      }),
    ).toThrow("must be an absolute host path");
    expect(
      readTargetWorkspace({
        FAILURE_REPORT_TARGET_WORKSPACE: "/Volumes/GitHub/CKBoost",
      }),
    ).toBe("/Volumes/GitHub/CKBoost");
  });
});

async function createHarness(
  options: {
    gitTopLevel?: string;
    origin?: string;
    revisionAvailable?: boolean;
    fetchFails?: boolean;
    nonGit?: boolean;
  } = {},
) {
  const target = await realpath(await temporaryDirectory());
  const availableRevisions = new Set<string>(
    options.revisionAvailable ? [baseRevision] : [],
  );
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const git: GitCommandRunner = async ({ cwd, args }) => {
    calls.push({ cwd, args });
    if (args.join(" ") === "rev-parse --show-toplevel") {
      if (options.nonGit) {
        throw new Error("not a git repository at /private/target");
      }
      return options.gitTopLevel ?? target;
    }
    if (args.join(" ") === "remote get-url origin") {
      return options.origin ?? canonicalRemote;
    }
    if (args.join(" ") === "fetch --prune origin") {
      if (options.fetchFails) {
        throw new Error("credential with /private/checkout detail");
      }
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
    throw new Error("Unexpected Git command: " + args.join(" "));
  };
  const manager = new DiagnosticTargetWorkspaceManager({
    targetWorkspace: target,
    git,
    paths: { lstat, realpath },
    remoteForRepository: () => canonicalRemote,
  });
  return { calls, git, manager, target };
}

function reportIdentity(options: { targetRepository?: string } = {}) {
  return {
    target: {
      repository: options.targetRepository ?? "Alive24/CKBoost",
      revision: baseRevision,
    },
    shared_context: {
      repository: "Alive24/CKBoost",
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(
    join(tmpdir(), "failure-report-target-workspace-"),
  );
  temporaryRoots.push(path);
  return path;
}
