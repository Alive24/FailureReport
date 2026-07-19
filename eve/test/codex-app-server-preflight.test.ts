import { describe, expect, it } from "vitest";

import {
  createCodexAppServerPreflight,
  type CodexAppServerHostRuntime,
  type CodexAppServerProcess,
} from "../agent/lib/backends/codex-app-server-preflight.js";
import {
  createDiagnosticSessionPreparer,
  type DiagnosticSessionPreparationWorkpad,
} from "../agent/lib/diagnostics/session-preparer.js";
import type { DomainExtension } from "../agent/lib/diagnostics/domain-extensions.js";
import type { PreparedDiagnosticSession } from "../agent/lib/diagnostics/workpad.js";
import { DiagnosticSafetyError } from "../agent/lib/diagnostics/worktree.js";

const worktreePath = "/root/.eve/sandbox-cache/worktrees/diagnostic-report";
const skillName = "failure-report-ckb-debugging";
const configuredCodex = "/configured/bin/codex";

describe("Codex App Server host-runtime preflight", () => {
  it("completes only initialize and skills/list against the configured executable and worktree", async () => {
    const process = readyProcess();
    const runtime = new FakeHostRuntime([process]);
    const preflight = createCodexAppServerPreflight({ host_runtime: runtime });

    await expect(preflight(preflightInput())).resolves.toEqual({
      status: "ready",
      attempts: 1,
    });
    expect(runtime.starts).toEqual([
      { executable: configuredCodex, cwd: worktreePath },
    ]);
    expect(Object.hasOwn(runtime.starts[0] ?? {}, "env")).toBe(false);
    expect(process.requests).toEqual([
      expect.objectContaining({ method: "initialize" }),
      {
        method: "skills/list",
        params: { cwds: [worktreePath], forceReload: true },
      },
    ]);
    expect(process.notifications).toEqual([
      { method: "initialized", params: {} },
    ]);
    expect(process.requests.map((request) => request.method)).not.toContain(
      "thread/start",
    );
    expect(process.disposeCount).toBe(1);
  });

  it("returns a sanitized needs_input result when the configured executable is unavailable", async () => {
    const missing = Object.assign(new Error("spawn failed"), {
      code: "ENOENT",
    });
    const runtime = new FakeHostRuntime([missing]);
    const preflight = createCodexAppServerPreflight({ host_runtime: runtime });

    await expect(preflight(preflightInput())).resolves.toMatchObject({
      status: "needs_input",
      category: "executable_unavailable",
      attempts: 1,
    });
    expect(runtime.starts).toHaveLength(1);
  });

  it("retains an asynchronous child-process executable failure for classification", async () => {
    const preflight = createCodexAppServerPreflight();

    await expect(
      preflight({
        executable: "/definitely-not-a-failure-report-codex-executable",
        workspace: {
          path: process.cwd(),
          native_skill_names: [skillName],
        },
      }),
    ).resolves.toMatchObject({
      status: "needs_input",
      category: "executable_unavailable",
      attempts: 1,
    });
  });

  it("classifies ambient Codex state and credential failures without exposing raw host details", async () => {
    const stateRuntime = new FakeHostRuntime([
      new FakeProcess({
        initialize: new Error("SQLite readonly database at /private/state"),
      }),
    ]);
    const statePreflight = createCodexAppServerPreflight({
      host_runtime: stateRuntime,
    });
    const stateResult = await statePreflight(preflightInput());

    expect(stateResult).toMatchObject({
      status: "needs_input",
      category: "state_inaccessible",
      attempts: 1,
    });
    expect(JSON.stringify(stateResult)).not.toContain("/private/state");

    const credentialsRuntime = new FakeHostRuntime([
      new FakeProcess({ initialize: new Error("Codex login required") }),
    ]);
    const credentialsPreflight = createCodexAppServerPreflight({
      host_runtime: credentialsRuntime,
    });

    await expect(credentialsPreflight(preflightInput())).resolves.toMatchObject(
      {
        status: "needs_input",
        category: "credentials_unavailable",
        attempts: 1,
      },
    );
  });

  it("rejects an invalid Root workspace during safe retry revalidation", async () => {
    const first = new FakeProcess({
      initialize: new Error("connection reset during startup"),
    });
    const runtime = new FakeHostRuntime([first]);
    const preflight = createCodexAppServerPreflight({ host_runtime: runtime });
    let revalidations = 0;

    const result = await preflight({
      ...preflightInput(),
      revalidate_workspace: async () => {
        revalidations += 1;
        throw new DiagnosticSafetyError(
          "The saved diagnostic worktree resolves outside Root-owned containment.",
        );
      },
    });

    expect(result).toMatchObject({
      status: "needs_input",
      category: "workspace_invalid",
      attempts: 1,
    });
    expect(revalidations).toBe(1);
    expect(first.disposeCount).toBe(1);
    expect(runtime.starts).toHaveLength(1);
  });

  it("returns needs_input when a Root-selected project skill is absent", async () => {
    const process = new FakeProcess({
      initialize: {},
      "skills/list": skillsResponse([]),
    });
    const runtime = new FakeHostRuntime([process]);
    const preflight = createCodexAppServerPreflight({ host_runtime: runtime });

    await expect(preflight(preflightInput())).resolves.toMatchObject({
      status: "needs_input",
      category: "project_skill_missing",
      attempts: 1,
    });
    expect(process.disposeCount).toBe(1);
  });

  it("cleans up and retries a timeout once with a fresh process", async () => {
    const first = new FakeProcess({
      initialize: () => new Promise<unknown>(() => undefined),
    });
    const second = new FakeProcess({
      initialize: () => new Promise<unknown>(() => undefined),
    });
    const runtime = new FakeHostRuntime([first, second]);
    const preflight = createCodexAppServerPreflight({
      host_runtime: runtime,
      timeout_ms: 5,
    });

    const result = await preflight(preflightInput());

    expect(result).toMatchObject({
      status: "needs_input",
      category: "timeout",
      attempts: 2,
    });
    expect(runtime.starts).toHaveLength(2);
    expect(first.disposeCount).toBe(1);
    expect(second.disposeCount).toBe(1);
  });

  it("uses one fresh child process and stops after retry exhaustion", async () => {
    const events: string[] = [];
    const first = new FakeProcess(
      { initialize: new Error("transport reset") },
      "first",
      events,
    );
    const second = new FakeProcess(
      { initialize: new Error("transport reset") },
      "second",
      events,
    );
    const runtime = new FakeHostRuntime([first, second], events);
    const preflight = createCodexAppServerPreflight({ host_runtime: runtime });
    let revalidations = 0;

    const result = await preflight({
      ...preflightInput(),
      revalidate_workspace: async () => {
        revalidations += 1;
        events.push("revalidate");
        return preflightInput().workspace;
      },
    });

    expect(result).toMatchObject({
      status: "needs_input",
      category: "startup_failed",
      attempts: 2,
    });
    expect(runtime.starts).toHaveLength(2);
    expect(revalidations).toBe(1);
    expect(first.disposeCount).toBe(1);
    expect(second.disposeCount).toBe(1);
    expect(events.indexOf("dispose:first")).toBeLessThan(
      events.indexOf("revalidate"),
    );
    expect(events.indexOf("revalidate")).toBeLessThan(
      events.indexOf("start:second"),
    );
  });

  it("withholds delegation after a non-recoverable preflight failure", async () => {
    const prepared = preparedSession();
    const workpad = fakeWorkpad(prepared);
    const preflightInputs: unknown[] = [];
    const preparer = createDiagnosticSessionPreparer({
      backend_id: "codex_app_server",
      codex_path: configuredCodex,
      dependencies: {
        resolve_domain_extensions: () => [ckbExtension],
        create_workpad: () => workpad,
        preflight: async (input) => {
          preflightInputs.push(input);
          return {
            status: "needs_input",
            category: "state_inaccessible",
            reason: "sanitized state access guidance",
            attempts: 1,
          };
        },
      },
    });

    const result = await preparer({
      domain_extensions: ["ckb"],
      report_id: "report-1",
      repository: "Alive24/CKBoost",
      issue_number: 54,
      request: "Inspect the failing boundary.",
    });

    expect(result).toEqual({
      status: "needs_input",
      domain_extensions: ["ckb"],
      report_id: "report-1",
      reason: "sanitized state access guidance",
      preflight_failure: "state_inaccessible",
    });
    expect(result).not.toHaveProperty("delegation_message");
    expect(preflightInputs).toEqual([
      expect.objectContaining({
        executable: configuredCodex,
        workspace: {
          path: worktreePath,
          native_skill_names: [skillName],
        },
      }),
    ]);
  });

  it("does not start App Server preflight when worktree containment validation fails", async () => {
    let preflightCalls = 0;
    const workpad: DiagnosticSessionPreparationWorkpad = {
      async prepare() {
        throw new DiagnosticSafetyError(
          "The saved diagnostic worktree resolves outside Root-owned containment.",
        );
      },
      async loadForDiagnosticSession() {
        throw new Error(
          "Containment failure must not be retried as delegation.",
        );
      },
    };
    const preparer = createDiagnosticSessionPreparer({
      backend_id: "codex_app_server",
      codex_path: configuredCodex,
      dependencies: {
        resolve_domain_extensions: () => [ckbExtension],
        create_workpad: () => workpad,
        preflight: async () => {
          preflightCalls += 1;
          return { status: "ready", attempts: 1 };
        },
      },
    });

    await expect(
      preparer({
        domain_extensions: ["ckb"],
        report_id: "report-1",
        repository: "Alive24/CKBoost",
        issue_number: 54,
        request: "Inspect the failing boundary.",
      }),
    ).resolves.toMatchObject({
      status: "needs_input",
      preflight_failure: "workspace_invalid",
    });
    expect(preflightCalls).toBe(0);
  });

  it("uses workpad revalidation as the only recovery before a successful retry", async () => {
    const first = new FakeProcess({ initialize: new Error("transport reset") });
    const second = readyProcess();
    const runtime = new FakeHostRuntime([first, second]);
    const prepared = preparedSession();
    let reloads = 0;
    const workpad = fakeWorkpad(prepared, () => {
      reloads += 1;
    });
    const preparer = createDiagnosticSessionPreparer({
      backend_id: "codex_app_server",
      codex_path: configuredCodex,
      dependencies: {
        resolve_domain_extensions: () => [ckbExtension],
        create_workpad: () => workpad,
        preflight: createCodexAppServerPreflight({ host_runtime: runtime }),
      },
    });

    await expect(
      preparer({
        domain_extensions: ["ckb"],
        report_id: "report-1",
        repository: "Alive24/CKBoost",
        issue_number: 54,
        request: "Inspect the failing boundary.",
      }),
    ).resolves.toMatchObject({
      status: "prepared",
      delegation_message: "delegation",
    });
    expect(reloads).toBe(1);
    expect(runtime.starts).toHaveLength(2);
    expect(first.disposeCount).toBe(1);
    expect(second.disposeCount).toBe(1);
  });
});

function preflightInput() {
  return {
    executable: configuredCodex,
    workspace: {
      path: worktreePath,
      native_skill_names: [skillName],
    },
  };
}

function readyProcess(): FakeProcess {
  return new FakeProcess({
    initialize: {},
    "skills/list": skillsResponse([skillName]),
  });
}

function skillsResponse(names: readonly string[]) {
  return {
    data: [
      {
        cwd: worktreePath,
        errors: [],
        skills: names.map((name) => ({ name, scope: "repo" })),
      },
    ],
  };
}

type ProcessOutcome = unknown | Error | (() => Promise<unknown>);

class FakeProcess implements CodexAppServerProcess {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  disposeCount = 0;

  constructor(
    private readonly outcomes: Record<string, ProcessOutcome>,
    readonly label = "process",
    private readonly events: string[] = [],
  ) {}

  request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    this.events.push("request:" + this.label + ":" + method);
    const outcome = this.outcomes[method];
    if (outcome instanceof Error) {
      return Promise.reject(outcome);
    }
    if (typeof outcome === "function") {
      return outcome();
    }
    return Promise.resolve(outcome);
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    this.events.push("dispose:" + this.label);
  }
}

class FakeHostRuntime implements CodexAppServerHostRuntime {
  readonly starts: Array<{ executable: string; cwd: string }> = [];

  constructor(
    private readonly processes: Array<CodexAppServerProcess | Error>,
    private readonly events: string[] = [],
  ) {}

  startAppServer(input: {
    executable: string;
    cwd: string;
  }): CodexAppServerProcess {
    this.starts.push(input);
    const next = this.processes.shift();
    if (!next) {
      throw new Error("Unexpected App Server start.");
    }
    const label = next instanceof FakeProcess ? next.label : "failed";
    this.events.push("start:" + label);
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

const ckbExtension: DomainExtension = {
  id: "ckb",
  native_skills: [
    {
      name: skillName,
      source_root: "/extension",
      source_directory: "/extension/skills/" + skillName,
    },
  ],
};

function preparedSession(): PreparedDiagnosticSession {
  return {
    report: { id: "report-1" },
    workpad_revision: 7,
    delegation_message: "delegation",
    diagnostic_session: {
      canonical_path: "/root/.eve/sandbox-cache/sources/ckboost",
      state: {
        lifecycle: "active",
        domain_extensions: ["ckb"],
        backend_id: "codex_app_server",
        worktree: {
          path: worktreePath,
          identity: "diagnostic-report",
          base_revision: "a".repeat(40),
          head_revision: "a".repeat(40),
        },
      },
    },
  } as unknown as PreparedDiagnosticSession;
}

function fakeWorkpad(
  prepared: PreparedDiagnosticSession,
  onLoad?: () => void,
): DiagnosticSessionPreparationWorkpad {
  return {
    async prepare() {
      return prepared;
    },
    async loadForDiagnosticSession() {
      onLoad?.();
      return {
        report: prepared.report,
        workpad_revision: prepared.workpad_revision,
        diagnostic_session: prepared.diagnostic_session,
      };
    },
  };
}
