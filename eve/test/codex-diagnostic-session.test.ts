import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  failureReportSchema,
  parseFailureReportWorkpad,
  type FailureReport,
} from "@failure-report/protocol";

import { createCodexAppServerModelResolver } from "../agent/lib/backends/codex-app-server-model.js";
import type { CodexAppServerBackendConfig } from "../agent/lib/backends/codex-app-server-config.js";
import { diagnosticSessionPreparationEnvelopeSchema } from "../agent/lib/diagnostics/envelope.js";
import type { DiagnosticDomainProfile } from "../agent/lib/diagnostics/domain-profiles.js";
import {
  DiagnosticSessionWorkpad,
  type DiagnosticSessionIssueGateway,
} from "../agent/lib/diagnostics/workpad.js";
import {
  DiagnosticWorktreeManager,
  type GitCommandRunner,
  type WorktreePathOperations,
} from "../agent/lib/diagnostics/worktree.js";
import {
  prepareIssueWorkpadMutation,
  type GithubIssueSnapshot,
} from "../agent/lib/integrations/github/issue-workpad.js";

/** End-to-end-in-memory coverage for Root's Codex diagnostic-session boundary. */

const canonicalPath = "/canonical/CKBoost";
const worktreeRoot = "/isolated/failure-report";
const nativeSkillRoot = "/extensions/ckb-domain-pack";
const nativeSkillSource =
  nativeSkillRoot + "/extension/skills/failure-report-ckb-debugging";
const nativeSkillName = "failure-report-ckb-debugging";

const backend: CodexAppServerBackendConfig = {
  schema_version: "failure-report/codex-app-server/v1",
  kind: "codex_app_server",
  codex_path: "codex",
  model: "gpt-5.4",
  approval_mode: "on-request",
  sandbox_mode: "workspace-write",
  reasoning_effort: "medium",
  model_context_window_tokens: 200000,
  worktree_root: worktreeRoot,
};

type Harness = {
  report: FailureReport;
  profile: DiagnosticDomainProfile;
  manager: DiagnosticWorktreeManager;
  workpad: DiagnosticSessionWorkpad;
  paths: FakePathOperations;
  currentReport(): FailureReport;
  setHead(value: string): void;
  calls: Array<{ cwd: string; args: string[] }>;
};

describe("Codex diagnostic session", () => {
  it("allocates a Root-owned worktree, materializes the native skill, and rejects an external HEAD change", async () => {
    const harness = await createHarness();
    const allocated = await harness.manager.allocate(harness.report);
    const skillLink = nativeSkillLink(allocated.state.worktree.path);

    expect(harness.paths.linkTarget(skillLink)).toBe(nativeSkillSource);
    expect(allocated.state.worktree.branch).toMatch(
      /^failure-report\/diagnostic\/ckb\//,
    );
    await expect(
      harness.manager.restore(harness.report, allocated.state),
    ).resolves.toMatchObject({
      state: {
        domain_id: "ckb",
        worktree: { branch: allocated.state.worktree.branch },
      },
    });
    expect(harness.calls).toContainEqual(
      expect.objectContaining({
        args: [
          "worktree",
          "add",
          "-b",
          allocated.state.worktree.branch,
          allocated.state.worktree.path,
          harness.report.target.revision,
        ],
      }),
    );

    harness.setHead("changed-outside-failure-report");
    await expect(
      harness.manager.restore(harness.report, allocated.state),
    ).rejects.toThrow("HEAD changed outside FailureReport");
    await expect(
      harness.manager.captureCurrent(harness.report, allocated.state),
    ).resolves.toMatchObject({
      state: { worktree: { head_revision: "changed-outside-failure-report" } },
    });
  });

  it("rebuilds only a missing native skill symlink and rejects unsafe replacements", async () => {
    const harness = await createHarness();
    const allocated = await harness.manager.allocate(harness.report);
    const skillLink = nativeSkillLink(allocated.state.worktree.path);

    harness.paths.removeLink(skillLink);
    await expect(
      harness.manager.restore(harness.report, allocated.state),
    ).resolves.toBeDefined();
    expect(harness.paths.linkTarget(skillLink)).toBe(nativeSkillSource);

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

  it("fails closed when the registered skill source is missing", async () => {
    const profile = createProfile("/missing/skill-source");
    const harness = await createHarness({ profile });

    await expect(harness.manager.allocate(harness.report)).rejects.toThrow(
      "native skill source is missing",
    );
    expect(
      harness.calls.some(
        (call) => call.args[0] === "worktree" && call.args[1] === "add",
      ),
    ).toBe(false);
  });

  it("fails closed when a registered skill source escapes its extension package", async () => {
    const profile = createProfile("/external/skill-source");
    const harness = await createHarness({ profile });
    harness.paths.addDirectory("/external/skill-source");
    harness.paths.addFile("/external/skill-source/SKILL.md");

    await expect(harness.manager.allocate(harness.report)).rejects.toThrow(
      "resolves outside its extension package",
    );
  });

  it("persists a Codex thread and resumes it in the same Root-provided cwd", async () => {
    const harness = await createHarness();
    const prepared = await harness.workpad.prepare(
      diagnosticSessionPreparationEnvelopeSchema.parse({
        schema_version: "failure-report/diagnostic-session/v1",
        domain_id: "ckb",
        report_id: harness.report.id,
        repository: "Alive24/CKBoost",
        issue_number: 54,
        request: "Inspect the first failing CKB boundary.",
        native_skill_names: [nativeSkillName],
      }),
    );
    expect(prepared.delegation_message).toMatch(
      new RegExp("^\\$" + nativeSkillName),
    );

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
    while (!(await reader.read()).done) {
      // Drain the finish part so the workpad journal records the final HEAD.
    }

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
});

async function createHarness(
  options: { profile?: DiagnosticDomainProfile } = {},
): Promise<Harness> {
  const fixture = new URL(
    "../../packages/protocol/test/fixtures/issue-54.json",
    import.meta.url,
  );
  const loaded = failureReportSchema.parse(
    JSON.parse(await readFile(fixture, "utf8")),
  );
  const report = failureReportSchema.parse({
    ...loaded,
    target: {
      ...loaded.target,
      source_checkout_path: canonicalPath,
    },
  });
  const calls: Array<{ cwd: string; args: string[] }> = [];
  let worktreePath: string | undefined;
  let branch = "";
  let head = report.target.revision;
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
    if (
      command ===
      "rev-parse --verify " + report.target.revision + "^{commit}"
    ) {
      return report.target.revision;
    }
    if (input.args[0] === "worktree" && input.args[1] === "add") {
      branch = input.args[3] ?? "";
      worktreePath = input.args[4];
      return "";
    }
    if (command === "rev-parse HEAD") {
      return head;
    }
    if (command === "branch --show-current") {
      return branch;
    }
    if (command === "merge-base " + report.target.revision + " " + head) {
      return report.target.revision;
    }
    if (command === "remote get-url origin") {
      return "git@github.com:Alive24/CKBoost.git";
    }
    throw new Error("Unexpected git command: " + input.cwd + " git " + command);
  };
  const profile = options.profile ?? createProfile();
  const manager = new DiagnosticWorktreeManager({
    profile,
    backendId: "codex_app_server",
    root: worktreeRoot,
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
    profile,
    manager,
    workpad,
    paths,
    currentReport: gateway.currentReport,
    setHead(value) {
      head = value;
    },
    calls,
  };
}

function createProfile(
  sourceDirectory = nativeSkillSource,
): DiagnosticDomainProfile {
  return {
    domain_id: "ckb",
    native_skills: [
      {
        name: nativeSkillName,
        source_root: nativeSkillRoot,
        source_directory: sourceDirectory,
      },
    ],
  };
}

function createIssueGateway(
  report: FailureReport,
): DiagnosticSessionIssueGateway & {
  currentReport(): FailureReport;
} {
  const initialIssue: GithubIssueSnapshot = {
    repository: "Alive24/CKBoost",
    issue_number: 54,
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
  };
}

/** In-memory filesystem with symlink visibility and no implicit overwrites. */
class FakePathOperations implements WorktreePathOperations {
  private readonly directories = new Set<string>([
    canonicalPath,
    worktreeRoot,
    nativeSkillRoot,
    nativeSkillSource,
  ]);
  private readonly files = new Set<string>([
    join(nativeSkillSource, "SKILL.md"),
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

function nativeSkillLink(worktreePath: string): string {
  return join(worktreePath, ".agents", "skills", nativeSkillName);
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
