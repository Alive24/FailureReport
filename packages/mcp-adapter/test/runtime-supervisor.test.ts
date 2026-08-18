import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RootInvoker, RootRequest } from "@failure-report/protocol";

import {
  readRuntimeSupervisorConfig,
  RuntimeSupervisedRootInvoker,
  RuntimeSupervisor,
  type RuntimeSupervisorConfig,
} from "../src/index.js";

const request: RootRequest = {
  request_id: "runtime-supervisor-69",
  operation: "inspect",
  issue_selector: {
    repository: "Alive24/FailureReport",
    issue_number: 69,
  },
  message: "Inspect the existing Issue.",
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "failure-report-supervisor-"));
  temporaryRoots.push(path);
  return path;
}

async function managedConfig(
  overrides: Partial<RuntimeSupervisorConfig> = {},
): Promise<RuntimeSupervisorConfig> {
  const root = await temporaryRoot();
  return {
    mode: "managed-local",
    host: "http://127.0.0.1:2000",
    trusted_repositories: [
      {
        repository: "Alive24/FailureReport",
        checkout: "/private/trusted/failure-report",
      },
    ],
    runtime_root: "/private/failure-report-runtime-source",
    state_root: root,
    readiness_timeout_ms: 100,
    poll_interval_ms: 10,
    idle_timeout_ms: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function matchingBinding(instanceId = "instance-69"): Response {
  return jsonResponse({
    schema_version: "failure-report/runtime-binding/v1",
    status: "ready",
    repository: "Alive24/FailureReport",
    revision: "a".repeat(40),
    instance_id: instanceId,
  });
}

describe("runtime supervisor configuration", () => {
  it("keeps trusted checkout paths in private managed-local configuration", () => {
    const config = readRuntimeSupervisorConfig(
      {
        FAILURE_REPORT_RUNTIME_MODE: "managed-local",
        FAILURE_REPORT_TRUSTED_REPOSITORIES: JSON.stringify({
          repositories: [
            {
              repository: "Alive24/FailureReport",
              checkout: "/private/trusted/failure-report",
            },
          ],
        }),
        FAILURE_REPORT_RUNTIME_STATE_ROOT: "/private/state",
      },
      "/private/source",
    );

    expect(config).toMatchObject({
      mode: "managed-local",
      host: "http://127.0.0.1:2000",
      trusted_repositories: [
        {
          repository: "Alive24/FailureReport",
          checkout: "/private/trusted/failure-report",
        },
      ],
    });
  });

  it("keeps the remote repository pin optional for legacy host configuration", () => {
    expect(
      readRuntimeSupervisorConfig({
        FAILURE_REPORT_EVE_HOST: "https://eve.example.test",
      }),
    ).toMatchObject({
      mode: "remote",
      host: "https://eve.example.test",
    });
  });

  it("rejects relative and duplicate trusted mappings", () => {
    expect(() =>
      readRuntimeSupervisorConfig({
        FAILURE_REPORT_RUNTIME_MODE: "managed-local",
        FAILURE_REPORT_TRUSTED_REPOSITORIES: JSON.stringify({
          repositories: [
            { repository: "Alive24/FailureReport", checkout: "./untrusted" },
            { repository: "Alive24/FailureReport", checkout: "/other" },
          ],
        }),
      }),
    ).toThrow();
  });
});

describe("runtime-supervised Root invocation", () => {
  it("reuses a healthy matching remote runtime before invoking Root", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(matchingBinding());
    const inner: RootInvoker = {
      invoke: vi.fn().mockResolvedValue({
        request_id: request.request_id,
        status: "completed",
        summary: "Root completed.",
      }),
    };
    const supervisor = new RuntimeSupervisor(
      {
        mode: "remote",
        host: "https://eve.example.test",
        remote_repository: "Alive24/FailureReport",
        trusted_repositories: [],
        runtime_root: "/unused",
        state_root: await temporaryRoot(),
        readiness_timeout_ms: 100,
        poll_interval_ms: 10,
        idle_timeout_ms: 0,
      },
      { fetch: fetcher },
    );

    const result = await new RuntimeSupervisedRootInvoker(
      inner,
      supervisor,
    ).invoke(request);

    expect(result.status).toBe("completed");
    expect(inner.invoke).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails remote mode closed without starting a local replacement", async () => {
    const inner: RootInvoker = { invoke: vi.fn() };
    const supervisor = new RuntimeSupervisor(
      {
        mode: "remote",
        host: "https://eve.example.test",
        remote_repository: "Alive24/FailureReport",
        trusted_repositories: [],
        runtime_root: "/unused",
        state_root: await temporaryRoot(),
        readiness_timeout_ms: 100,
        poll_interval_ms: 10,
        idle_timeout_ms: 0,
      },
      {
        fetch: vi.fn().mockRejectedValue(new Error("offline")),
        spawn_runtime: vi.fn(),
      },
    );

    const result = await new RuntimeSupervisedRootInvoker(
      inner,
      supervisor,
    ).invoke(request);

    expect(result).toMatchObject({ status: "failed" });
    expect(result.summary).toContain("[remote_unavailable]");
    expect(inner.invoke).not.toHaveBeenCalled();
  });

  it("rejects a healthy runtime bound to another repository", async () => {
    const inner: RootInvoker = { invoke: vi.fn() };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          schema_version: "failure-report/runtime-binding/v1",
          status: "ready",
          repository: "Alive24/Other",
          revision: "a".repeat(40),
          instance_id: "other-instance",
        }),
      );
    const supervisor = new RuntimeSupervisor(await managedConfig(), {
      fetch: fetcher,
      validate_checkout: vi.fn().mockResolvedValue("/private/trusted"),
    });

    const result = await new RuntimeSupervisedRootInvoker(
      inner,
      supervisor,
    ).invoke(request);

    expect(result.summary).toContain("[wrong_repository_binding]");
    expect(inner.invoke).not.toHaveBeenCalled();
  });

  it("rejects a healthy runtime without an immutable revision binding", async () => {
    const inner: RootInvoker = { invoke: vi.fn() };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          schema_version: "failure-report/runtime-binding/v1",
          status: "ready",
          repository: "Alive24/FailureReport",
          instance_id: "legacy-instance",
        }),
      );
    const supervisor = new RuntimeSupervisor(await managedConfig(), {
      fetch: fetcher,
      validate_checkout: vi.fn().mockResolvedValue("/private/trusted"),
    });

    const result = await new RuntimeSupervisedRootInvoker(
      inner,
      supervisor,
    ).invoke(request);

    expect(result.summary).toContain("[binding_unverified]");
    expect(inner.invoke).not.toHaveBeenCalled();
  });

  it("returns operator-only missing-provisioning guidance without leaking a path", async () => {
    const inner: RootInvoker = { invoke: vi.fn() };
    const config = await managedConfig({ trusted_repositories: [] });
    const supervisor = new RuntimeSupervisor(config, {
      fetch: vi.fn().mockRejectedValue(new Error("offline")),
    });

    const result = await new RuntimeSupervisedRootInvoker(
      inner,
      supervisor,
    ).invoke(request);

    expect(result.summary).toContain("[missing_provisioning]");
    expect(result.summary).not.toContain("/private/");
    expect(inner.invoke).not.toHaveBeenCalled();
  });

  it("single-flights concurrent managed-local startup", async () => {
    let ready = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (!ready) {
        return jsonResponse({ ok: false }, 503);
      }
      return url.endsWith("/eve/v1/health")
        ? jsonResponse({ ok: true })
        : matchingBinding("started-instance");
    });
    const spawnRuntime = vi.fn().mockImplementation(async () => {
      ready = true;
      return {
        instance_id: "started-instance",
        pid: 6900,
        log_path: "/private/log",
      };
    });
    const supervisor = new RuntimeSupervisor(await managedConfig(), {
      fetch: fetcher,
      validate_checkout: vi.fn().mockResolvedValue("/private/trusted"),
      spawn_runtime: spawnRuntime,
      process_alive: () => true,
    });
    const inner: RootInvoker = {
      invoke: vi.fn().mockImplementation(async (current: RootRequest) => ({
        request_id: current.request_id,
        status: "completed",
        summary: "Root completed.",
      })),
    };
    const invoker = new RuntimeSupervisedRootInvoker(inner, supervisor);

    const [first, second] = await Promise.all([
      invoker.invoke(request),
      invoker.invoke({ ...request, request_id: "runtime-supervisor-69-b" }),
    ]);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(spawnRuntime).toHaveBeenCalledOnce();
    expect(inner.invoke).toHaveBeenCalledTimes(2);
  });

  it("bounds readiness waiting and leaves Root uncalled on timeout", async () => {
    let now = 0;
    const terminate = vi.fn();
    const inner: RootInvoker = { invoke: vi.fn() };
    const supervisor = new RuntimeSupervisor(await managedConfig(), {
      fetch: vi.fn().mockResolvedValue(jsonResponse({ ok: false }, 503)),
      validate_checkout: vi.fn().mockResolvedValue("/private/trusted"),
      spawn_runtime: vi.fn().mockResolvedValue({
        instance_id: "starting-instance",
        pid: 6901,
        log_path: "/private/log",
      }),
      process_alive: () => true,
      terminate,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    const result = await new RuntimeSupervisedRootInvoker(
      inner,
      supervisor,
    ).invoke(request);

    expect(result.summary).toContain("[readiness_timeout]");
    expect(inner.invoke).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledWith(6901);
  });

  it("persists private supervisor state for restart reuse", async () => {
    let ready = false;
    const stateRoot = await temporaryRoot();
    const config = await managedConfig({ state_root: stateRoot });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (!ready) return jsonResponse({ ok: false }, 503);
      return String(input).endsWith("/eve/v1/health")
        ? jsonResponse({ ok: true })
        : matchingBinding("restart-instance");
    });
    const spawnRuntime = vi.fn().mockImplementation(async () => {
      ready = true;
      return {
        instance_id: "restart-instance",
        pid: 6902,
        log_path: "/private/log",
      };
    });
    const dependencies = {
      fetch: fetcher,
      validate_checkout: vi.fn().mockResolvedValue("/private/trusted"),
      spawn_runtime: spawnRuntime,
      process_alive: () => true,
    };

    await new RuntimeSupervisor(config, dependencies).ensure(
      "Alive24/FailureReport",
    );
    await new RuntimeSupervisor(config, dependencies).ensure(
      "Alive24/FailureReport",
    );

    expect(spawnRuntime).toHaveBeenCalledOnce();
    const stateFiles = (await import("node:fs/promises")).readdir(stateRoot);
    const names = await stateFiles;
    const stateName = names.find((name) => name.endsWith(".json"));
    expect(stateName).toBeDefined();
    expect(await readFile(join(stateRoot, stateName!), "utf8")).toContain(
      "restart-instance",
    );
  });

  it("does not idle-terminate an active diagnostic session", async () => {
    vi.useFakeTimers();
    let ready = false;
    const terminate = vi.fn();
    const config = await managedConfig({ idle_timeout_ms: 50 });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (!ready) return jsonResponse({ ok: false }, 503);
      return String(input).endsWith("/eve/v1/health")
        ? jsonResponse({ ok: true })
        : matchingBinding("active-instance");
    });
    const supervisor = new RuntimeSupervisor(config, {
      fetch: fetcher,
      validate_checkout: vi.fn().mockResolvedValue("/private/trusted"),
      spawn_runtime: vi.fn().mockImplementation(async () => {
        ready = true;
        return {
          instance_id: "active-instance",
          pid: 6903,
          log_path: "/private/log",
        };
      }),
      process_alive: () => true,
      terminate,
    });
    await supervisor.ensure("Alive24/FailureReport");
    supervisor.beginInvocation("Alive24/FailureReport");
    await supervisor.finishInvocation("Alive24/FailureReport", {
      request_id: request.request_id,
      status: "completed",
      summary: "Diagnosis active.",
      report: {
        id: "report-69",
        schema_version: "failure-report/v1",
        status: "investigating",
        created_at: "2026-08-17T12:00:00Z",
        updated_at: "2026-08-17T12:00:00Z",
        origin: { source: "manual", reporter: "operator", related_work: [] },
        target: {
          repository: "Alive24/FailureReport",
          revision: "a".repeat(40),
          components: ["packages/mcp-adapter"],
          environment: [],
        },
        severity: "medium",
        symptom: { observed_behavior: ["Runtime unavailable"] },
        evidence: [],
        hypotheses: [],
        experiments: [],
        unknowns: [],
        decision_log: [],
        outcome: { readiness: "not_ready", todo_status: "not_ready" },
        diagnostic_session: {
          lifecycle: "active",
          domain_extensions: [],
          backend_id: "codex",
          worktree: {
            identity: "diagnostic-69",
            base_revision: "a".repeat(40),
            head_revision: "a".repeat(40),
          },
          diagnostic_branch_slug: "runtime-supervision",
        },
      },
    } as never);

    await vi.advanceTimersByTimeAsync(100);

    expect(terminate).not.toHaveBeenCalled();
  });

  it("idle-terminates only a matching supervisor-owned inactive runtime", async () => {
    let ready = false;
    const terminate = vi.fn();
    const config = await managedConfig({ idle_timeout_ms: 50 });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (!ready) return jsonResponse({ ok: false }, 503);
      return String(input).endsWith("/eve/v1/health")
        ? jsonResponse({ ok: true })
        : matchingBinding("idle-instance");
    });
    const supervisor = new RuntimeSupervisor(config, {
      fetch: fetcher,
      validate_checkout: vi.fn().mockResolvedValue("/private/trusted"),
      spawn_runtime: vi.fn().mockImplementation(async () => {
        ready = true;
        return {
          instance_id: "idle-instance",
          pid: 6904,
          log_path: "/private/log",
        };
      }),
      process_alive: () => true,
      terminate,
    });
    await supervisor.ensure("Alive24/FailureReport");
    supervisor.beginInvocation("Alive24/FailureReport");
    await supervisor.finishInvocation("Alive24/FailureReport");

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    expect(terminate).toHaveBeenCalledWith(6904);
  });
});
