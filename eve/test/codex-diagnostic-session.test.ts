import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  failureReportSchema,
  parseFailureReportWorkpad,
  workpadMarker,
  type FailureReport,
} from "@failure-report/protocol";

import { createCodexAppServerModelResolver } from "../agent/lib/backends/codex-app-server-model.js";
import {
  parseCodexAppServerBackendConfig,
  type CodexAppServerBackendConfig,
} from "../agent/lib/backends/codex-app-server-config.js";
import { diagnosticSessionPreparationEnvelopeSchema } from "../agent/lib/diagnostics/envelope.js";
import type { DomainExtension } from "../agent/lib/diagnostics/domain-extensions.js";
import {
  DiagnosticSessionWorkpad,
  diagnosticBranchSlugFor,
  type DiagnosticSessionIssueGateway,
} from "../agent/lib/diagnostics/workpad.js";
import type { DiagnosticSourceResolver } from "../agent/lib/diagnostics/source-cache.js";
import {
  DiagnosticWorktreeManager,
  type GitCommandRunner,
  type WorktreePathOperations,
} from "../agent/lib/diagnostics/worktree.js";
import {
  prepareIssueWorkpadMutation,
  type GithubIssueSnapshot,
} from "../agent/lib/integrations/github/issue-workpad.js";
import sandbox from "../agent/sandbox.js";

/** End-to-end-in-memory coverage for Root's Codex diagnostic-session boundary. */

const canonicalPath = "/canonical/CKBoost";
const canonicalRemote = "https://github.com/Alive24/CKBoost.git";
const runtimeRoot = "/sandbox/failure-report";
const worktreeRoot = join(runtimeRoot, ".eve", "sandbox-cache", "worktrees");
const ckbSkillRoot = "/extensions/ckb-domain-pack";
const ckbSkillSource =
  ckbSkillRoot + "/extension/skills/failure-report-ckb-debugging";
const ckbSkillName = "failure-report-ckb-debugging";
const evmSkillRoot = "/extensions/evm-domain-pack";
const evmSkillSource =
  evmSkillRoot + "/extension/skills/failure-report-evm-debugging";
const evmSkillName = "failure-report-evm-debugging";

const backend: CodexAppServerBackendConfig = {
  schema_version: "failure-report/codex-app-server/v1",
  kind: "codex_app_server",
  codex_path: "codex",
  model: "gpt-5.4",
  approval_mode: "on-request",
  sandbox_mode: "workspace-write",
  reasoning_effort: "medium",
  model_context_window_tokens: 200000,
};

type Harness = {
  report: FailureReport;
  domainExtensions: readonly DomainExtension[];
  manager: DiagnosticWorktreeManager;
  workpad: DiagnosticSessionWorkpad;
  paths: FakePathOperations;
  currentReport(): FailureReport;
  currentBranch(): string;
  removeDiagnosticBranchSlug(): void;
  setIssueTitle(value: string): void;
  setHead(value: string): void;
  setPorcelain(value: string): void;
  setSnapshotBranch(name: string, head: string): void;
  setRemoteSnapshotBranch(ref: string, head: string): void;
  calls: Array<{ cwd: string; args: string[] }>;
};

describe("Codex diagnostic session", () => {
  it("pins Eve to just-bash and rejects configurable host workspace roots", () => {
    expect(
      (sandbox as unknown as { backend?: { name?: string } }).backend?.name,
    ).toBe("just-bash");
    expect(() =>
      parseCodexAppServerBackendConfig({
        ...backend,
        worktree_root: "/caller-selected/worktree-root",
      }),
    ).toThrow();
    expect(() =>
      parseCodexAppServerBackendConfig({
        ...backend,
        source_root: "/caller-selected/source-root",
      }),
    ).toThrow();
  });

  it("allocates a detached Root-owned worktree and rejects an external HEAD change", async () => {
    const harness = await createHarness();
    const allocated = await harness.manager.allocate(
      harness.report,
      "ckboost-issue-54",
    );
    const skillLink = nativeSkillLink(
      allocated.state.worktree.path,
      ckbSkillName,
    );

    expect(harness.paths.linkTarget(skillLink)).toBe(ckbSkillSource);
    expect(allocated.state).toMatchObject({
      lifecycle: "active",
      domain_extensions: ["ckb"],
      worktree: {
        identity: expect.stringMatching(/^diagnostic-/),
      },
    });
    expect(allocated.state.worktree).not.toHaveProperty("branch");
    expect(harness.currentBranch()).toBe("");
    expect(harness.calls).toContainEqual(
      expect.objectContaining({
        args: [
          "worktree",
          "add",
          "--detach",
          allocated.state.worktree.path,
          harness.report.target.revision,
        ],
      }),
    );
    await expect(
      harness.manager.restore(harness.report, allocated.state),
    ).resolves.toMatchObject({
      state: {
        lifecycle: "active",
        domain_extensions: ["ckb"],
      },
    });

    const externallyChangedHead = "b".repeat(40);
    harness.setHead(externallyChangedHead);
    await expect(
      harness.manager.restore(harness.report, allocated.state),
    ).rejects.toThrow("HEAD changed outside FailureReport");
    await expect(
      harness.manager.captureCurrent(harness.report, allocated.state),
    ).resolves.toMatchObject({
      state: { worktree: { head_revision: externallyChangedHead } },
    });
  });

  it("rejects a symlinked managed worktree root before allocating a checkout", async () => {
    const harness = await createHarness();
    harness.paths.addDirectory("/outside/worktrees");
    harness.paths.setLink(worktreeRoot, "/outside/worktrees");

    await expect(
      harness.manager.allocate(harness.report, "ckboost-issue-54"),
    ).rejects.toThrow(
      "`.eve/sandbox-cache/worktrees` directory cannot be resolved safely",
    );
    expect(
      harness.calls.some(
        (call) => call.args[0] === "worktree" && call.args[1] === "add",
      ),
    ).toBe(false);
  });

  it("materializes every selected extension skill in deterministic delegation order", async () => {
    const harness = await createHarness({
      domainExtensions: [createCkbExtension(), createEvmExtension()],
    });
    const prepared = await harness.workpad.prepare(preparationFor(harness));
    const allocated = prepared.diagnostic_session;

    expect(allocated.state.domain_extensions).toEqual(["ckb", "evm"]);
    expect(
      harness.paths.linkTarget(
        nativeSkillLink(allocated.state.worktree.path, ckbSkillName),
      ),
    ).toBe(ckbSkillSource);
    expect(
      harness.paths.linkTarget(
        nativeSkillLink(allocated.state.worktree.path, evmSkillName),
      ),
    ).toBe(evmSkillSource);

    expect(prepared.delegation_message).toMatch(
      /^\$failure-report-ckb-debugging \$failure-report-evm-debugging/m,
    );
    expect(prepared.diagnostic_session.state.domain_extensions).toEqual([
      "ckb",
      "evm",
    ]);
  });

  it("derives a safe, stable diagnostic branch slug from the target Issue title", () => {
    expect(diagnosticBranchSlugFor("Fix: CKB #54 — Node RPC")).toBe(
      "fix-ckb-54-node-rpc",
    );
    expect(diagnosticBranchSlugFor("---")).toBe("diagnostic");
  });

  it("persists the initial Issue-title slug across diagnostic reentry", async () => {
    const harness = await createHarness();
    const first = await harness.workpad.prepare(preparationFor(harness));
    harness.setIssueTitle("A renamed target Issue");

    const resumed = await harness.workpad.prepare(preparationFor(harness));
    expect(first.diagnostic_session.state.diagnostic_branch_slug).toBe(
      "ckboost-issue-54",
    );
    expect(resumed.diagnostic_session.state.diagnostic_branch_slug).toBe(
      "ckboost-issue-54",
    );
  });

  it("persists a recovered legacy active-session slug before another reentry", async () => {
    const harness = await createHarness();
    const first = await harness.workpad.prepare(preparationFor(harness));
    harness.removeDiagnosticBranchSlug();
    harness.setIssueTitle("Legacy CKBoost #54");

    const recovered = await harness.workpad.prepare(preparationFor(harness));
    expect(recovered.workpad_revision).toBe(first.workpad_revision + 1);
    expect(recovered.diagnostic_session.state.diagnostic_branch_slug).toBe(
      "legacy-ckboost-54",
    );
    expect(
      harness.currentReport().diagnostic_session?.diagnostic_branch_slug,
    ).toBe("legacy-ckboost-54");

    harness.setIssueTitle(
      "A later Issue title must not replace the persisted slug",
    );
    const resumed = await harness.workpad.prepare(preparationFor(harness));
    expect(resumed.diagnostic_session.state.diagnostic_branch_slug).toBe(
      "legacy-ckboost-54",
    );
  });

  it("rebuilds only a missing native skill symlink and rejects unsafe replacements", async () => {
    const harness = await createHarness();
    const allocated = await harness.manager.allocate(
      harness.report,
      "ckboost-issue-54",
    );
    const skillLink = nativeSkillLink(
      allocated.state.worktree.path,
      ckbSkillName,
    );

    harness.paths.removeLink(skillLink);
    await expect(
      harness.manager.restore(harness.report, allocated.state),
    ).resolves.toBeDefined();
    expect(harness.paths.linkTarget(skillLink)).toBe(ckbSkillSource);

    harness.paths.setLink(skillLink, "/unexpected-skill-source");
    harness.paths.addDirectory("/unexpected-skill-source");
    await expect(
      harness.manager.restore(harness.report, allocated.state),
    ).rejects.toThrow("points at an unexpected source");

    harness.paths.removeLink(skillLink);
    harness.paths.addFile(skillLink);
    await expect(
      harness.manager.restore(harness.report, allocated.state),
    ).rejects.toThrow("non-symlink native skill entry");
  });

  it("fails closed when a selected extension skill source is missing or escapes its package", async () => {
    const missing = await createHarness({
      domainExtensions: [createCkbExtension("/missing/skill-source")],
    });
    await expect(
      missing.manager.allocate(missing.report, "ckboost-issue-54"),
    ).rejects.toThrow("native skill source is missing");
    expect(
      missing.calls.some(
        (call) => call.args[0] === "worktree" && call.args[1] === "add",
      ),
    ).toBe(false);

    const escaped = await createHarness({
      domainExtensions: [createCkbExtension("/external/skill-source")],
    });
    escaped.paths.addDirectory("/external/skill-source");
    escaped.paths.addFile("/external/skill-source/SKILL.md");
    await expect(
      escaped.manager.allocate(escaped.report, "ckboost-issue-54"),
    ).rejects.toThrow("resolves outside its extension package");

    const duplicate = await createHarness({
      domainExtensions: [
        createCkbExtension(),
        {
          id: "evm",
          native_skills: [
            {
              name: ckbSkillName,
              source_root: evmSkillRoot,
              source_directory: evmSkillSource,
            },
          ],
        },
      ],
    });
    await expect(
      duplicate.manager.allocate(duplicate.report, "ckboost-issue-54"),
    ).rejects.toThrow("invalid native skill name");
  });

  it("rejects an envelope that tries to change the active extension set", async () => {
    const harness = await createHarness();
    await expect(
      harness.workpad.prepare(
        diagnosticSessionPreparationEnvelopeSchema.parse({
          schema_version: "failure-report/diagnostic-session/v1",
          domain_extensions: ["ckb", "evm"],
          report_id: harness.report.id,
          repository: "Alive24/CKBoost",
          issue_number: 54,
          request: "Inspect the first failing CKB boundary.",
          native_skill_names: [ckbSkillName, evmSkillName],
        }),
      ),
    ).rejects.toThrow("native skills do not match");
  });

  it("persists a Codex thread and resumes it in the same Root-provided cwd", async () => {
    const harness = await createHarness();
    const prepared = await harness.workpad.prepare(preparationFor(harness));

    const providerSettings: Array<Record<string, unknown>> = [];
    const createProvider = ((options: {
      defaultSettings: Record<string, unknown>;
    }) => {
      providerSettings.push(options.defaultSettings);
      return () => ({
        specificationVersion: "v3" as const,
        provider: "codex-app-server",
        modelId: "gpt-5.4",
        supportedUrls: {},
        defaultObjectGenerationMode: "json" as const,
        supportsStructuredOutputs: true,
        supportsImageUrls: true,
        async doStream() {
          const threadId =
            (options.defaultSettings.resume as string | undefined) ??
            "thr-ckb-54";
          const onSessionCreated = options.defaultSettings.onSessionCreated as
            ((session: { threadId: string }) => void) | undefined;
          onSessionCreated?.({ threadId });
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: "tool-input-start",
                  id: "native-command",
                  toolName: "exec",
                });
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "native-command",
                  toolName: "exec",
                  input: { command: "git status --short" },
                  providerExecuted: true,
                });
                controller.enqueue({
                  type: "tool-result",
                  toolCallId: "native-command",
                  toolName: "exec",
                  result: { exitCode: 0 },
                });
                controller.enqueue({
                  type: "text-delta",
                  id: "diagnostic-text",
                  delta: "Collected native diagnostic evidence.",
                });
                controller.enqueue({
                  type: "finish",
                  providerMetadata: { codex: { sessionId: threadId } },
                });
                controller.close();
              },
            }),
          };
        },
        async doGenerate() {
          throw new Error("The test exercises the streaming Eve path.");
        },
      });
    }) as never;
    const resolveModel = createCodexAppServerModelResolver(backend, {
      diagnostic_session_workpad: harness.workpad,
      create_provider: createProvider,
    });

    const first = await resolveModel([
      { role: "user", content: prepared.delegation_message },
    ]);
    const streamingModel = first.model as unknown as {
      doStream(options: unknown): Promise<{ stream: ReadableStream<unknown> }>;
    };
    const result = await streamingModel.doStream({});
    const reader = result.stream.getReader();
    const parts: Array<{ type?: string }> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      parts.push(next.value as { type?: string });
    }

    expect(parts.map((part) => part.type)).toEqual(["text-delta", "finish"]);

    expect(providerSettings[0]?.cwd).toBe(
      prepared.diagnostic_session.state.worktree.path,
    );
    expect(providerSettings[0]?.sandboxMode).toBe("workspace-write");
    expect(providerSettings[0]?.approvalMode).toBe("on-request");
    expect(providerSettings[0]?.resume).toBeUndefined();
    expect(harness.currentReport().diagnostic_session?.codex_thread_id).toBe(
      "thr-ckb-54",
    );
    expect(
      harness.currentReport().diagnostic_session?.last_diagnosed_at,
    ).toBeTruthy();

    await resolveModel([
      { role: "user", content: prepared.delegation_message },
    ]);
    expect(providerSettings[1]?.resume).toBe("thr-ckb-54");
  });

  it("finalizes a clean detached diagnosis into an idempotent snapshot branch without checkout", async () => {
    const harness = await createHarness();
    const prepared = await harness.workpad.prepare(preparationFor(harness));
    const input = finalizationInput(harness);
    const expectedBranch = "diagnostic/54-ckboost-issue-54";
    const expectedRemoteRef = "refs/heads/" + expectedBranch;
    harness.setPorcelain("?? .agents/skills/" + ckbSkillName);

    const finalized = await harness.workpad.finalize(input);
    expect(finalized.diagnostic_session).toMatchObject({
      lifecycle: "finalized",
      diagnostic_branch: {
        name: expectedBranch,
        head_revision: harness.report.target.revision,
        remote_name: "origin",
        remote_ref: expectedRemoteRef,
        remote_url:
          "https://github.com/Alive24/CKBoost/tree/diagnostic/54-ckboost-issue-54",
        reuse_policy: "diagnostic_snapshot_only",
      },
    });
    expect(harness.currentBranch()).toBe("");
    expect(harness.calls).toContainEqual(
      expect.objectContaining({
        args: ["status", "--porcelain", "--untracked-files=all"],
      }),
    );
    expect(harness.calls).toContainEqual(
      expect.objectContaining({
        args: ["branch", expectedBranch, harness.report.target.revision],
      }),
    );
    expect(harness.calls).toContainEqual(
      expect.objectContaining({
        args: ["push", "origin", expectedRemoteRef + ":" + expectedRemoteRef],
      }),
    );
    expect(
      harness.calls.some(
        (call) => call.args[0] === "push" && call.args.includes("--force"),
      ),
    ).toBe(false);

    const repeated = await harness.workpad.finalize(input);
    expect(repeated.workpad_revision).toBe(finalized.workpad_revision);
    expect(
      harness.calls.filter(
        (call) => call.args[0] === "branch" && call.args[1] === expectedBranch,
      ),
    ).toHaveLength(1);
    await expect(
      harness.workpad.prepare(preparationFor(harness)),
    ).rejects.toThrow("finalized");
    await expect(
      harness.manager.restore(harness.report, finalized.diagnostic_session),
    ).rejects.toThrow("finalized");
  });

  it("refuses dirty worktrees and conflicting local or remote diagnostic snapshot refs", async () => {
    const dirty = await createHarness();
    await dirty.workpad.prepare(preparationFor(dirty));
    dirty.setPorcelain("?? diagnostic-output.txt");
    await expect(
      dirty.workpad.finalize(finalizationInput(dirty)),
    ).rejects.toThrow("must be clean");

    const conflicting = await createHarness();
    const prepared = await conflicting.workpad.prepare(
      preparationFor(conflicting),
    );
    conflicting.setSnapshotBranch(
      "diagnostic/54-ckboost-issue-54",
      "a".repeat(40),
    );
    await expect(
      conflicting.workpad.finalize(finalizationInput(conflicting)),
    ).rejects.toThrow("already points at a different revision");

    const remoteConflict = await createHarness();
    await remoteConflict.workpad.prepare(preparationFor(remoteConflict));
    remoteConflict.setRemoteSnapshotBranch(
      "refs/heads/diagnostic/54-ckboost-issue-54",
      "b".repeat(40),
    );
    await expect(
      remoteConflict.workpad.finalize(finalizationInput(remoteConflict)),
    ).rejects.toThrow("remote diagnostic snapshot branch already points");
  });
});

async function createHarness(
  options: { domainExtensions?: readonly DomainExtension[] } = {},
): Promise<Harness> {
  const fixture = new URL(
    "../../packages/protocol/test/fixtures/issue-54.json",
    import.meta.url,
  );
  const loaded = failureReportSchema.parse(
    JSON.parse(await readFile(fixture, "utf8")),
  );
  const report = loaded;
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const snapshotBranches = new Map<string, string>();
  const remoteSnapshotBranches = new Map<string, string>();
  let worktreePath: string | undefined;
  let currentBranch = "";
  let head = report.target.revision;
  let porcelain = "";
  const paths = new FakePathOperations({
    getWorktreePath: () => worktreePath,
  });
  const git: GitCommandRunner = async (input) => {
    calls.push(input);
    const command = input.args.join(" ");
    if (command === "rev-parse --show-toplevel") {
      if (input.cwd === canonicalPath) {
        return canonicalPath;
      }
      if (input.cwd === worktreePath) {
        return worktreePath;
      }
    }
    if (input.args[0] === "rev-parse" && input.args[1] === "--verify") {
      const revision = input.args[2];
      if (revision === report.target.revision + "^{commit}") {
        return report.target.revision;
      }
      const prefix = "refs/heads/";
      const suffix = "^{commit}";
      if (revision?.startsWith(prefix) && revision.endsWith(suffix)) {
        const name = revision.slice(prefix.length, -suffix.length);
        const snapshotHead = snapshotBranches.get(name);
        if (snapshotHead) {
          return snapshotHead;
        }
      }
      throw new Error("Missing test ref: " + revision);
    }
    if (input.args[0] === "worktree" && input.args[1] === "add") {
      worktreePath = input.args[3];
      return "";
    }
    if (command === "rev-parse HEAD") {
      return head;
    }
    if (command === "branch --show-current") {
      return currentBranch;
    }
    if (input.args[0] === "branch" && input.args[1] && input.args[2]) {
      snapshotBranches.set(input.args[1], input.args[2]);
      return "";
    }
    if (
      input.args[0] === "ls-remote" &&
      input.args[1] === "--heads" &&
      input.args[2] === "origin" &&
      input.args[3]
    ) {
      const ref = input.args[3];
      const remoteHead = remoteSnapshotBranches.get(ref);
      return remoteHead ? remoteHead + "\t" + ref : "";
    }
    if (
      input.args[0] === "push" &&
      input.args[1] === "origin" &&
      input.args[2]
    ) {
      const [sourceRef, destinationRef] = input.args[2].split(":");
      const sourceName = sourceRef?.replace(/^refs\/heads\//, "");
      const sourceHead = sourceName
        ? snapshotBranches.get(sourceName)
        : undefined;
      if (!sourceHead || !destinationRef?.startsWith("refs/heads/")) {
        throw new Error("Invalid diagnostic snapshot push.");
      }
      remoteSnapshotBranches.set(destinationRef, sourceHead);
      return "";
    }
    if (command === "status --porcelain --untracked-files=all") {
      return porcelain;
    }
    if (command === "merge-base " + report.target.revision + " " + head) {
      return report.target.revision;
    }
    if (command === "remote get-url origin") {
      return canonicalRemote;
    }
    throw new Error("Unexpected git command: " + input.cwd + " git " + command);
  };
  const domainExtensions = options.domainExtensions ?? [createCkbExtension()];
  const sourceCache: DiagnosticSourceResolver = {
    async acquire() {
      return {
        canonical_path: canonicalPath,
        canonical_remote: canonicalRemote,
        base_revision: report.target.revision,
      };
    },
    async restore(_report, recordedBaseRevision) {
      return {
        canonical_path: canonicalPath,
        canonical_remote: canonicalRemote,
        base_revision: recordedBaseRevision,
      };
    },
  };
  const manager = new DiagnosticWorktreeManager({
    domainExtensions,
    backendId: "codex_app_server",
    runtimeRoot,
    sourceCache,
    git,
    paths,
  });
  const gateway = createIssueGateway(report);
  let second = 2;
  const workpad = new DiagnosticSessionWorkpad({
    gateway,
    worktrees: manager,
    now: () => "2026-07-15T10:00:" + String(second++).padStart(2, "0") + "Z",
  });

  return {
    report,
    domainExtensions,
    manager,
    workpad,
    paths,
    currentReport: gateway.currentReport,
    currentBranch: () => currentBranch,
    removeDiagnosticBranchSlug: gateway.removeDiagnosticBranchSlug,
    setIssueTitle(value) {
      gateway.setTitle(value);
    },
    setHead(value) {
      head = value;
    },
    setPorcelain(value) {
      porcelain = value;
    },
    setSnapshotBranch(name, snapshotHead) {
      snapshotBranches.set(name, snapshotHead);
    },
    setRemoteSnapshotBranch(ref, snapshotHead) {
      remoteSnapshotBranches.set(ref, snapshotHead);
    },
    calls,
  };
}

function createCkbExtension(sourceDirectory = ckbSkillSource): DomainExtension {
  return {
    id: "ckb",
    native_skills: [
      {
        name: ckbSkillName,
        source_root: ckbSkillRoot,
        source_directory: sourceDirectory,
      },
    ],
  };
}

function createEvmExtension(): DomainExtension {
  return {
    id: "evm",
    native_skills: [
      {
        name: evmSkillName,
        source_root: evmSkillRoot,
        source_directory: evmSkillSource,
      },
    ],
  };
}

function preparationFor(harness: Harness) {
  return diagnosticSessionPreparationEnvelopeSchema.parse({
    schema_version: "failure-report/diagnostic-session/v1",
    domain_extensions: harness.domainExtensions.map(
      (extension) => extension.id,
    ),
    report_id: harness.report.id,
    repository: "Alive24/CKBoost",
    issue_number: 54,
    request: "Inspect the first failing boundary.",
    native_skill_names: harness.manager.nativeSkillNames(),
  });
}

function finalizationInput(harness: Harness) {
  return {
    report_id: harness.report.id,
    repository: "Alive24/CKBoost",
    issue_number: 54,
  };
}

function createIssueGateway(
  report: FailureReport,
): DiagnosticSessionIssueGateway & {
  currentReport(): FailureReport;
  removeDiagnosticBranchSlug(): void;
  setTitle(value: string): void;
} {
  const initialIssue: GithubIssueSnapshot = {
    repository: "Alive24/CKBoost",
    issue_number: 54,
    title: "CKBoost Issue 54",
    issue_url: "https://github.com/Alive24/CKBoost/issues/54",
    body: "# Existing Issue",
    updated_at: "2026-07-15T10:00:00Z",
    comments: [],
  };
  const initial = prepareIssueWorkpadMutation(
    initialIssue,
    report,
    "2026-07-15T10:00:01Z",
  );
  let issue: GithubIssueSnapshot = {
    ...initialIssue,
    updated_at: "2026-07-15T10:00:01Z",
    comments: [
      {
        id: "workpad-comment",
        body: initial.workpad_comment_body,
        updated_at: "2026-07-15T10:00:01Z",
      },
    ],
  };

  return {
    async readIssue() {
      return issue;
    },
    async publishSharedContext(
      _repository,
      _issueNumber,
      nextReport,
      syncedAt,
    ) {
      const mutation = prepareIssueWorkpadMutation(issue, nextReport, syncedAt);
      const commentRef = mutation.workpad_comment_ref ?? "workpad-comment";
      issue = {
        ...issue,
        updated_at: syncedAt,
        comments: issue.comments.map((comment) =>
          comment.id === commentRef
            ? {
                ...comment,
                body: mutation.workpad_comment_body,
                updated_at: syncedAt,
              }
            : comment,
        ),
      };
      return {
        issue,
        report: mutation.report,
        workpad_comment_ref: commentRef,
        workpad_revision: mutation.report.shared_context?.workpad_revision ?? 0,
      };
    },
    currentReport() {
      const comment = issue.comments[0];
      if (!comment) {
        throw new Error("Missing test workpad.");
      }
      return parseFailureReportWorkpad(comment.body).report;
    },
    removeDiagnosticBranchSlug() {
      const comment = issue.comments[0];
      if (!comment) {
        throw new Error("Missing test workpad.");
      }
      const parsed = parseFailureReportWorkpad(comment.body);
      const legacy = JSON.parse(JSON.stringify(parsed.report)) as {
        diagnostic_session?: Record<string, unknown>;
      };
      if (!legacy.diagnostic_session) {
        throw new Error("Test workpad has no diagnostic session.");
      }
      delete legacy.diagnostic_session.diagnostic_branch_slug;
      issue = {
        ...issue,
        comments: issue.comments.map((current) =>
          current.id === comment.id
            ? {
                ...current,
                body: [
                  workpadMarker,
                  '<!-- failure-report/v1 report-id="' +
                    parsed.report.id +
                    '" revision="' +
                    String(parsed.revision) +
                    '" -->',
                  "~~~json",
                  JSON.stringify({ failure_report: legacy }, null, 2),
                  "~~~",
                  "",
                ].join("\n"),
              }
            : current,
        ),
      };
    },
    setTitle(value) {
      issue = { ...issue, title: value };
    },
  };
}

/** In-memory filesystem with symlink visibility and no implicit overwrites. */
class FakePathOperations implements WorktreePathOperations {
  private readonly directories = new Set<string>([
    runtimeRoot,
    canonicalPath,
    worktreeRoot,
    ckbSkillRoot,
    ckbSkillSource,
    evmSkillRoot,
    evmSkillSource,
  ]);
  private readonly files = new Set<string>([
    join(ckbSkillSource, "SKILL.md"),
    join(evmSkillSource, "SKILL.md"),
  ]);
  private readonly links = new Map<string, string>();
  private readonly getWorktreePath: () => string | undefined;

  constructor(options: { getWorktreePath(): string | undefined }) {
    this.getWorktreePath = options.getWorktreePath;
  }

  async ensureDirectory(path: string): Promise<void> {
    if (this.files.has(path) || this.links.has(path)) {
      throw fileSystemError("EEXIST");
    }
    this.directories.add(path);
  }

  async realpath(path: string): Promise<string> {
    const linked = this.links.get(path);
    if (linked) {
      return this.realpath(linked);
    }
    if (
      this.directories.has(path) ||
      this.files.has(path) ||
      path === this.getWorktreePath()
    ) {
      return path;
    }
    throw fileSystemError("ENOENT");
  }

  async lstat(path: string) {
    if (this.links.has(path)) {
      return fakeStat(true, false);
    }
    if (this.directories.has(path) || path === this.getWorktreePath()) {
      return fakeStat(false, true);
    }
    if (this.files.has(path)) {
      return fakeStat(false, false);
    }
    throw fileSystemError("ENOENT");
  }

  async symlink(target: string, path: string): Promise<void> {
    if (
      this.links.has(path) ||
      this.directories.has(path) ||
      this.files.has(path)
    ) {
      throw fileSystemError("EEXIST");
    }
    this.links.set(path, target);
  }

  linkTarget(path: string): string | undefined {
    return this.links.get(path);
  }

  removeLink(path: string): void {
    this.links.delete(path);
  }

  setLink(path: string, target: string): void {
    this.files.delete(path);
    this.directories.delete(path);
    this.links.set(path, target);
  }

  addFile(path: string): void {
    this.links.delete(path);
    this.directories.delete(path);
    this.files.add(path);
  }

  addDirectory(path: string): void {
    this.files.delete(path);
    this.links.delete(path);
    this.directories.add(path);
  }
}

function nativeSkillLink(worktreePath: string, skillName: string): string {
  return join(worktreePath, ".agents", "skills", skillName);
}

function fakeStat(isSymbolicLink: boolean, isDirectory: boolean) {
  return {
    isSymbolicLink: () => isSymbolicLink,
    isDirectory: () => isDirectory,
  };
}

function fileSystemError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
