import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { failureReportSchema } from "@failure-report/protocol";

import type { DomainExtension } from "../agent/lib/diagnostics/domain-extensions.js";
import { DiagnosticSourceCacheManager } from "../agent/lib/diagnostics/source-cache.js";
import {
  DiagnosticWorktreeManager,
  type GitCommandRunner,
  type WorktreePathOperations,
} from "../agent/lib/diagnostics/worktree.js";

/** Exercises the real Host Local Runtime without a network or Codex model turn. */

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("host-managed diagnostic workspace", () => {
  it("clones and restores a detached worktree only below .eve/sandbox-cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "failure-report-host-runtime-"));
    temporaryRoots.push(root);
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    await gitCommand(root, ["init", "--bare", remote]);
    await gitCommand(root, ["init", seed]);
    await gitCommand(seed, [
      "config",
      "user.email",
      "failure-report@example.test",
    ]);
    await gitCommand(seed, ["config", "user.name", "FailureReport test"]);
    await writeFile(join(seed, "README.md"), "diagnostic fixture\n", "utf8");
    await gitCommand(seed, ["add", "README.md"]);
    await gitCommand(seed, ["commit", "-m", "fixture"]);
    const revision = await gitCommand(seed, ["rev-parse", "HEAD"]);
    await gitCommand(seed, ["remote", "add", "origin", remote]);
    await gitCommand(seed, ["push", "origin", "HEAD:main"]);

    const skillRoot = fileURLToPath(
      new URL("../../packages/ckb-domain-pack", import.meta.url),
    );
    const skillDirectory = join(
      skillRoot,
      "extension",
      "skills",
      "failure-report-ckb-debugging",
    );
    const extension: DomainExtension = {
      id: "ckb",
      native_skills: [
        {
          name: "failure-report-ckb-debugging",
          source_root: skillRoot,
          source_directory: skillDirectory,
        },
      ],
    };
    const sourceCache = new DiagnosticSourceCacheManager({
      runtimeRoot: root,
      git,
      paths,
      remoteForRepository: () => remote,
    });
    const worktrees = new DiagnosticWorktreeManager({
      domainExtensions: [extension],
      backendId: "codex_app_server",
      runtimeRoot: root,
      sourceCache,
      git,
      paths,
    });
    const report = failureReportSchema.parse({
      ...fixtureReport(),
      target: {
        ...fixtureReport().target,
        repository: "Alive24/CKBoost",
        revision,
      },
      shared_context: {
        provider: "github_issue",
        repository: "Alive24/CKBoost",
        issue_number: 56,
        issue_url: "https://github.com/Alive24/CKBoost/issues/56",
        workpad_marker: "<!-- failure-report-workpad -->",
        workpad_revision: 0,
      },
    });

    const allocated = await worktrees.allocate(report, "host-runtime-fixture");
    const canonicalRoot = await realpath(root);
    const expectedCacheRoot = join(
      canonicalRoot,
      ".eve",
      "sandbox-cache",
      "sources",
    );
    const expectedWorktreeRoot = join(
      canonicalRoot,
      ".eve",
      "sandbox-cache",
      "worktrees",
    );

    expect(isChild(expectedCacheRoot, allocated.canonical_path)).toBe(true);
    expect(isChild(expectedWorktreeRoot, allocated.state.worktree.path)).toBe(
      true,
    );
    expect(
      await gitCommand(allocated.state.worktree.path, [
        "branch",
        "--show-current",
      ]),
    ).toBe("");
    expect(
      await gitCommand(allocated.state.worktree.path, ["rev-parse", "HEAD"]),
    ).toBe(revision);
    await expect(
      worktrees.restore(report, allocated.state),
    ).resolves.toMatchObject({
      state: {
        lifecycle: "active",
        worktree: {
          path: allocated.state.worktree.path,
          base_revision: revision,
        },
      },
    });

    const branch = "diagnostic/56-host-runtime-fixture";
    const finalized = await worktrees.finalize(
      report,
      allocated.state,
      "2026-07-17T10:01:00Z",
    );
    expect(finalized.state).toMatchObject({
      lifecycle: "finalized",
      diagnostic_branch: {
        name: branch,
        head_revision: revision,
        remote_name: "origin",
        remote_ref: "refs/heads/" + branch,
        remote_url:
          "https://github.com/Alive24/CKBoost/tree/diagnostic/56-host-runtime-fixture",
        reuse_policy: "diagnostic_snapshot_only",
      },
    });
    expect(
      await gitCommand(allocated.state.worktree.path, [
        "branch",
        "--show-current",
      ]),
    ).toBe("");
    expect(
      await gitCommand(remote, ["rev-parse", "refs/heads/" + branch]),
    ).toBe(revision);
    await expect(
      worktrees.finalize(report, allocated.state, "2026-07-17T10:02:00Z"),
    ).resolves.toMatchObject({
      state: {
        lifecycle: "finalized",
        diagnostic_branch: { name: branch, head_revision: revision },
      },
    });
  });
});

function fixtureReport() {
  return failureReportSchema.parse({
    id: "ckboost-issue-56",
    schema_version: "failure-report/v1",
    status: "investigating",
    created_at: "2026-07-17T10:00:00Z",
    updated_at: "2026-07-17T10:00:00Z",
    origin: {
      source: "manual",
      reporter: "test",
      related_work: [],
    },
    target: {
      repository: "Alive24/CKBoost",
      revision: "0".repeat(40),
      components: ["runtime"],
      environment: [],
    },
    severity: "medium",
    symptom: {
      observed_behavior: ["fixture fails"],
      expected_behavior: ["fixture succeeds"],
      raw_error_summary: "fixture",
      first_seen_at: null,
      reproduction: {
        preconditions: [],
        steps: ["run fixture"],
        frequency: "always",
      },
    },
    inputs: [
      {
        id: "fixture-input",
        kind: "fixture",
        artifact: {
          ref: "fixture://host-managed-workspace",
          sensitivity: "internal",
        },
        provenance: {
          phase: "intake",
          source_type: "test",
          source_ref: "host-managed-workspace.test.ts",
          collector: "vitest",
        },
      },
    ],
    evidence: [
      {
        id: "fixture-evidence",
        kind: "tool_observation",
        observed_fact: "fixture initialized",
        epistemic_status: "observed",
        provenance: {
          phase: "investigation",
          source_type: "test",
          source_ref: "host-managed-workspace.test.ts",
          collector: "vitest",
        },
        artifacts: [],
      },
    ],
    hypotheses: [],
    decisions: [],
    experiments: [],
    conclusion: {
      diagnosis: "fixture",
      confidence: { level: "low", basis: "test fixture" },
      remaining_uncertainty: ["none"],
      recommended_remediation: ["none"],
    },
    handoff: {
      todo_status: "not_ready",
      gate_decision: "Need to Clarify",
      uat_required: false,
      goal: "fixture",
      why_now: "test",
      scope_in: ["fixture"],
      scope_out: ["production"],
      guardrails: ["fixture only"],
      required_outcomes: ["fixture passes"],
      verification: { automated: ["vitest"], uat: [], context: [] },
      remaining_assumptions: ["local git available"],
    },
    domain: {
      pack_id: "ckb",
      pack_version: "test",
      schema_ref: "fixture://schema",
      extension_data: {},
    },
  });
}

const paths: WorktreePathOperations = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  realpath,
  lstat,
  async symlink(target, path) {
    await symlink(target, path, "dir");
  },
};

const git: GitCommandRunner = async ({ cwd, args }) =>
  new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
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
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim()));
    });
  });

async function gitCommand(cwd: string, args: string[]): Promise<string> {
  return git({ cwd, args });
}

function isChild(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && !fromRoot.startsWith("../") && fromRoot !== "..";
}
