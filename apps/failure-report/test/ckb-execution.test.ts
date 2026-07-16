import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  failureReportSchema,
  parseFailureReportWorkpad,
  type FailureReport,
} from "@failure-report/protocol";

import {
  prepareIssueWorkpadMutation,
  type GithubIssueSnapshot,
} from "../integrations/github/issue-workpad.js";
import { createCkbCodexModelResolver } from "../src/domain-packs/ckb/codex-model.js";
import type { CkbCodexBackendConfig } from "../src/domain-packs/ckb/config.js";
import { createCkbExecutionEnvelope } from "../src/domain-packs/ckb/execution.js";
import {
  ExecutionWorkpad,
  type ExecutionIssueGateway,
} from "../src/execution/workpad.js";
import {
  ExecutionWorktreeManager,
  type GitCommandRunner,
  type WorktreePathOperations,
} from "../src/execution/worktree.js";

/**
 * End-to-end-in-memory coverage for the CKB execution boundary.
 *
 * The harness replaces GitHub, Git, filesystem, and Codex App-server with
 * deterministic fakes so it verifies durable thread/worktree behavior without a
 * checkout, credentials, or live model call.
 */

/** Canonical checkout represented by the fake Git/filesystem environment. */
const canonicalPath = "/canonical/CKBoost";
/** Root-owned parent directory for the fake isolated execution worktree. */
const worktreeRoot = "/isolated/failure-report";
/** Valid CKB provider configuration used only to construct the local test adapter. */
const backend: CkbCodexBackendConfig = {
  schema_version: "failure-report/ckb-backend/v1",
  kind: "codex_app_server",
  codex_path: "codex",
  model: "gpt-5.4",
  approval_mode: "on-request",
  sandbox_mode: "workspace-write",
  reasoning_effort: "medium",
  model_context_window_tokens: 200000,
  worktree_root: worktreeRoot,
};

/** Mutable handles exposed by the test harness to simulate external state changes. */
type Harness = {
  report: FailureReport;
  manager: ExecutionWorktreeManager;
  workpad: ExecutionWorkpad;
  currentReport(): FailureReport;
  setHead(value: string): void;
  calls: Array<{ cwd: string; args: string[] }>;
};

/** Covers allocation, safety rejection, and persistent-thread resume semantics. */
describe("CKB Codex execution", () => {
  it("allocates an isolated worktree and rejects resume after an unrecorded HEAD change", async () => {
    const harness = await createHarness();
    const allocated = await harness.manager.allocate(harness.report);

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

  it("rejects a saved CKB worktree that resolves to the canonical checkout", async () => {
    const harness = await createHarness();
    const allocated = await harness.manager.allocate(harness.report);
    const unsafePath = "/" + allocated.state.worktree.identity;
    const canonicalManager = new ExecutionWorktreeManager({
      domainId: "ckb",
      backendId: "codex_app_server",
      root: "/",
      git: createGitRunner(harness),
      paths: {
        async ensureDirectory() {},
        async realpath(path) {
          if (path === canonicalPath || path === unsafePath) {
            return canonicalPath;
          }
          if (path === "/") {
            return "/";
          }
          const error = new Error("not found") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
      },
    });
    const unsafeState = {
      ...allocated.state,
      worktree: {
        ...allocated.state.worktree,
        path: unsafePath,
      },
    };

    await expect(
      canonicalManager.restore(harness.report, unsafeState),
    ).rejects.toThrow("resolves to the canonical checkout");
  });

  it("rejects a saved worktree path whose resolved target escapes the isolated root", async () => {
    const harness = await createHarness();
    const allocated = await harness.manager.allocate(harness.report);
    const linkedPath = allocated.state.worktree.path;
    const escapedManager = new ExecutionWorktreeManager({
      domainId: "ckb",
      backendId: "codex_app_server",
      root: worktreeRoot,
      git: createGitRunner(harness),
      paths: {
        async ensureDirectory() {},
        async realpath(path) {
          if (path === canonicalPath) {
            return canonicalPath;
          }
          if (path === worktreeRoot) {
            return worktreeRoot;
          }
          if (path === linkedPath) {
            return "/external/CKBoost";
          }
          const error = new Error("not found") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
      },
    });
    const unsafeState = {
      ...allocated.state,
      worktree: {
        ...allocated.state.worktree,
        path: linkedPath,
      },
    };

    await expect(
      escapedManager.restore(harness.report, unsafeState),
    ).rejects.toThrow("resolves outside the configured isolated-worktree root");
  });

  it("persists the provider thread id and uses it to resume the next CKB model", async () => {
    const harness = await createHarness();
    const prepared = await harness.workpad.prepare(
      createCkbExecutionEnvelope({
        report_id: harness.report.id,
        repository: "Alive24/CKBoost",
        issue_number: 54,
        request: "Inspect the first failing CKB boundary.",
      }),
    );
    const providerSettings: Array<Record<string, unknown>> = [];
    // Mimic the provider's observable lifecycle: session creation yields a thread
    // id, and the stream's finish part exposes the same id as provider metadata.
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
    const resolveModel = createCkbCodexModelResolver(backend, {
      execution_workpad: harness.workpad,
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
      // Drain the completion part so the workpad journal captures the final HEAD.
    }

    expect(providerSettings[0]?.resume).toBeUndefined();
    expect(harness.currentReport().execution_state?.codex_thread_id).toBe(
      "thr-ckb-54",
    );
    expect(
      harness.currentReport().execution_state?.last_execution_at,
    ).toBeTruthy();

    await resolveModel([
      { role: "user", content: prepared.delegation_message },
    ]);
    expect(providerSettings[1]?.resume).toBe("thr-ckb-54");
  });
});

/**
 * Builds a fully deterministic fake repository, Issue workpad, and provider host.
 * The returned `setHead` simulates an out-of-band branch mutation between turns.
 */
async function createHarness(): Promise<Harness> {
  const fixture = new URL(
    "../../../packages/protocol/test/fixtures/issue-54.json",
    import.meta.url,
  );
  const loaded = failureReportSchema.parse(
    JSON.parse(await readFile(fixture, "utf8")),
  );
  const report = failureReportSchema.parse({
    ...loaded,
    target: {
      ...loaded.target,
      worktree_identity: canonicalPath,
    },
  });
  const calls: Array<{ cwd: string; args: string[] }> = [];
  let worktreePath: string | undefined;
  let branch = "";
  let head = report.target.revision;
  const paths = createPaths({
    get worktreePath() {
      return worktreePath;
    },
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
      // The manager chooses the branch/path; the fake only records the Git effect.
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
  const manager = new ExecutionWorktreeManager({
    domainId: "ckb",
    backendId: "codex_app_server",
    root: worktreeRoot,
    git,
    paths,
  });
  const gateway = createIssueGateway(report);
  let second = 2;
  const workpad = new ExecutionWorkpad({
    gateway,
    worktrees: manager,
    now: () => "2026-07-15T10:00:" + String(second++).padStart(2, "0") + "Z",
  });

  return {
    report,
    manager,
    workpad,
    currentReport: gateway.currentReport,
    setHead(value) {
      head = value;
    },
    calls,
  };
}

/**
 * Creates an in-memory Issue gateway that always represents exactly one workpad.
 * It intentionally reuses production mutation helpers so the fake preserves the
 * same revision and serialization rules as GitHub-backed execution.
 */
function createIssueGateway(report: FailureReport): ExecutionIssueGateway & {
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

/** Filesystem fake that resolves only the canonical checkout, root, and allocated path. */
function createPaths(source: {
  readonly worktreePath?: string;
}): WorktreePathOperations {
  return {
    async ensureDirectory() {},
    async realpath(path) {
      if (path === canonicalPath) {
        return canonicalPath;
      }
      if (path === worktreeRoot) {
        return worktreeRoot;
      }
      if (path === source.worktreePath) {
        return path;
      }
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  };
}

/**
 * Replays previously observed Git results for canonical-fallback rejection tests.
 * Any command beyond the expected safety path fails the test rather than masking a
 * new fallback behavior.
 */
function createGitRunner(harness: Harness): GitCommandRunner {
  return async (input) => {
    const matching = harness.calls
      .slice()
      .reverse()
      .find(
        (call) =>
          call.cwd === input.cwd &&
          call.args.join(" ") === input.args.join(" "),
      );
    if (!matching) {
      throw new Error("Unexpected canonical-manager git command.");
    }
    if (input.args.join(" ") === "rev-parse --show-toplevel") {
      return input.cwd;
    }
    if (input.args.join(" ") === "rev-parse HEAD") {
      return harness.currentReport().target.revision;
    }
    if (input.args.join(" ").startsWith("branch --show-current")) {
      throw new Error(
        "Canonical fallback should fail before branch inspection.",
      );
    }
    return harness.currentReport().target.revision;
  };
}
