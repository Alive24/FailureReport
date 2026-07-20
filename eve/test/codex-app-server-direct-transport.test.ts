import { describe, expect, it } from "vitest";

import type { NativeApprovalTerminalEvidence } from "@failure-report/protocol";

import { createCodexAppServerModelResolver } from "../agent/lib/backends/codex-app-server-model.js";
import {
  parseCodexAppServerBackendConfig,
  type CodexAppServerBackendConfig,
} from "../agent/lib/backends/codex-app-server-config.js";
import { createDiagnosticNativeApprovalBroker } from "../agent/lib/backends/native-approval-broker.js";
import type {
  CodexAppServerNotification,
  CodexAppServerRequestId,
  CodexAppServerServerRequest,
  DirectCodexAppServerHostRuntime,
  DirectCodexAppServerProcess,
} from "../agent/lib/backends/codex-app-server-transport.js";
import {
  diagnosticSessionEnvelopeSchema,
  renderDiagnosticSessionEnvelope,
  type DiagnosticSessionEnvelope,
} from "../agent/lib/diagnostics/envelope.js";
import type { DiagnosticSessionWorkpad } from "../agent/lib/diagnostics/workpad.js";

const worktreePath = "/root/.eve/sandbox-cache/worktrees/diagnostic-54";
const envelope = diagnosticSessionEnvelopeSchema.parse({
  schema_version: "failure-report/diagnostic-session/v1",
  domain_extensions: ["ckb"],
  report_id: "report-54",
  repository: "Alive24/CKBoost",
  issue_number: 54,
  workpad_revision: 1,
  request: "Inspect the first failing boundary.",
  native_skill_names: ["failure-report-ckb-debugging"],
});
const backend: CodexAppServerBackendConfig = {
  schema_version: "failure-report/codex-app-server/v1",
  kind: "codex_app_server",
  codex_path: "/configured/bin/codex",
  model: "gpt-5.4",
  approval_mode: "on-request",
  approvals_reviewer: "auto_review",
  sandbox_mode: "workspace-write",
  reasoning_effort: "medium",
  model_context_window_tokens: 200000,
};

/** Deterministic protocol coverage for the direct, host-managed App Server path. */
describe("direct Codex App Server diagnostic transport", () => {
  it("defaults native auto-review and rejects a wider diagnostic configuration", () => {
    const { approvals_reviewer: _reviewer, ...withoutReviewer } = backend;
    expect(parseCodexAppServerBackendConfig(withoutReviewer)).toMatchObject({
      approval_mode: "on-request",
      approvals_reviewer: "auto_review",
      sandbox_mode: "workspace-write",
    });
    expect(() =>
      parseCodexAppServerBackendConfig({
        ...backend,
        approval_mode: "never",
      }),
    ).toThrow();
    expect(() =>
      parseCodexAppServerBackendConfig({
        ...backend,
        sandbox_mode: "danger-full-access",
      }),
    ).toThrow();
  });

  it("starts and resumes one Root-owned thread with auto-review while filtering native events", async () => {
    const workpad = new FakeWorkpad();
    const firstProcess = new FakeDirectProcess();
    const first = await startModel(workpad, firstProcess);

    expect(first.runtime.starts).toEqual([
      { executable: backend.codex_path, cwd: worktreePath },
    ]);
    expect(firstProcess.requestFor("thread/start")?.params).toEqual(
      expect.objectContaining({
        model: backend.model,
        cwd: worktreePath,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        developerInstructions: expect.stringContaining(
          "Do not make target-repository business-code changes",
        ),
      }),
    );
    expect(firstProcess.requestFor("turn/start")?.params).toEqual(
      expect.objectContaining({
        threadId: "thread-54",
        cwd: worktreePath,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        model: backend.model,
        effort: "medium",
      }),
    );

    await firstProcess.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-54",
        turnId: "turn-54",
        itemId: "message-54",
        delta: "Collected native diagnostic evidence.",
      },
    });
    const rawApproval = {
      id: "opaque-request-id-54",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-54",
        turnId: "turn-54",
        itemId: "command-54",
        command: "curl https://example.invalid?token=hidden",
        cwd: "/private/raw-approval-cwd",
        commandActions: [{ type: "unknown", command: "secret" }],
      },
    } as const;
    await firstProcess.emitServerRequest(rawApproval);
    expect(firstProcess.responses).toEqual([]);

    await firstProcess.emitNotification({
      method: "item/autoApprovalReview/completed",
      params: {
        threadId: "thread-54",
        turnId: "turn-54",
        targetItemId: "command-54",
        reviewId: "review-54",
        review: { status: "approved" },
        action: { type: "command" },
      },
    });
    expect(firstProcess.responses).toEqual([
      { id: "opaque-request-id-54", result: { decision: "accept" } },
    ]);
    expect(workpad.terminals).toEqual([
      expect.objectContaining({
        status: "resolved",
        decision: "approve",
        turn_id: "turn-54",
      }),
    ]);

    await completeTurn(firstProcess);
    const firstParts = await drain(first.stream);
    expect(firstParts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(
      firstParts.some(
        (part) =>
          typeof part.type === "string" && part.type.startsWith("tool-"),
      ),
    ).toBe(false);
    const durable = JSON.stringify(workpad.terminals);
    expect(durable).not.toContain(rawApproval.id);
    expect(durable).not.toContain("review-54");
    expect(durable).not.toContain(rawApproval.params.command);
    expect(durable).not.toContain(rawApproval.params.cwd);
    expect(workpad.completions).toEqual([
      { thread_id: "thread-54", provider_finish_reason: "completed" },
    ]);

    const resumedProcess = new FakeDirectProcess({ thread_id: "thread-54" });
    const resumed = await startModel(workpad, resumedProcess);
    expect(resumedProcess.requestFor("thread/start")).toBeUndefined();
    expect(resumedProcess.requestFor("thread/resume")?.params).toEqual(
      expect.objectContaining({
        threadId: "thread-54",
        cwd: worktreePath,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        developerInstructions: expect.stringContaining(
          "Do not make target-repository business-code changes",
        ),
      }),
    );
    expect(resumedProcess.requestFor("turn/start")?.params).toEqual(
      expect.objectContaining({
        threadId: "thread-54",
        cwd: worktreePath,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
      }),
    );
    await completeTurn(resumedProcess);
    await drain(resumed.stream);
    expect(workpad.completions).toHaveLength(2);
  });

  it("keeps an agent message that arrives before the turn-start response", async () => {
    const workpad = new FakeWorkpad();
    const process = new FakeDirectProcess({
      early_agent_delta: "Early native output was retained.",
    });
    const started = await startModel(workpad, process);

    await completeTurn(process);
    const parts = await drain(started.stream);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "text-delta",
        delta: "Early native output was retained.",
      }),
    );
  });

  it("journals an internally completed auto-review without a Root continuation", async () => {
    const workpad = new FakeWorkpad();
    const process = new FakeDirectProcess();
    const started = await startModel(workpad, process);
    await process.emitNotification(autoReview("approved"));

    expect(process.responses).toEqual([]);
    expect(workpad.terminals).toEqual([
      expect.objectContaining({ status: "resolved", decision: "approve" }),
    ]);
    expect(JSON.stringify(workpad.terminals)).not.toContain("review-54");
    await completeTurn(process);
    await drain(started.stream);
  });

  it("records a denied native approval without converting it into an Eve tool", async () => {
    const workpad = new FakeWorkpad();
    const process = new FakeDirectProcess();
    const started = await startModel(workpad, process);
    await process.emitServerRequest(commandApprovalRequest("denied-request"));
    await process.emitNotification(autoReview("denied"));

    expect(process.responses).toEqual([
      { id: "denied-request", result: { decision: "decline" } },
    ]);
    expect(workpad.terminals).toEqual([
      expect.objectContaining({ status: "resolved", decision: "deny" }),
    ]);
    await completeTurn(process);
    const parts = await drain(started.stream);
    expect(
      parts.some(
        (part) =>
          typeof part.type === "string" && part.type.includes("approval"),
      ),
    ).toBe(false);
  });

  it("fails closed when Codex native auto-review times out", async () => {
    const workpad = new FakeWorkpad();
    const process = new FakeDirectProcess();
    const started = await startModel(workpad, process);
    await process.emitServerRequest(commandApprovalRequest("review-timeout"));
    await process.emitNotification(autoReview("timedOut"));

    expect(process.responses).toEqual([
      { id: "review-timeout", result: { decision: "decline" } },
    ]);
    expect(workpad.terminals).toEqual([
      expect.objectContaining({ status: "resolved", decision: "deny" }),
    ]);
    await completeTurn(process);
    await drain(started.stream);
  });

  it("records cancellation after the App Server clears a live native request", async () => {
    const workpad = new FakeWorkpad();
    const process = new FakeDirectProcess();
    const started = await startModel(workpad, process);
    await process.emitServerRequest(
      commandApprovalRequest("cancelled-request"),
    );
    await process.emitNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-54", requestId: "cancelled-request" },
    });

    expect(process.responses).toEqual([]);
    expect(workpad.terminals).toEqual([
      expect.objectContaining({
        status: "cancelled",
        reason: "cancelled_by_backend",
      }),
    ]);
    await completeTurn(process);
    await drain(started.stream);
  });

  it("times out an unresolved native approval with a bounded denial", async () => {
    const timers = new FakeTimers();
    const workpad = new FakeWorkpad();
    const process = new FakeDirectProcess();
    const started = await startModel(workpad, process, timers);
    await process.emitServerRequest(
      commandApprovalRequest("timed-out-request"),
    );
    await timers.fireNext();

    expect(process.responses).toEqual([
      { id: "timed-out-request", result: { decision: "decline" } },
    ]);
    expect(workpad.terminals).toEqual([
      expect.objectContaining({ status: "timed_out", reason: "timeout" }),
    ]);
    await completeTurn(process);
    await drain(started.stream);
  });

  it("interrupts a live request on process loss and never replays its raw id", async () => {
    const workpad = new FakeWorkpad();
    const process = new FakeDirectProcess();
    const started = await startModel(workpad, process);
    const rawRequest = commandApprovalRequest("interrupted-request");
    await process.emitServerRequest(rawRequest);
    await process.close(new Error("stdio process lost"));

    expect(process.responses).toEqual([
      { id: "interrupted-request", result: { decision: "decline" } },
    ]);
    expect(workpad.terminals).toEqual([
      expect.objectContaining({
        status: "interrupted",
        reason: "process_interrupted",
      }),
    ]);
    expect(JSON.stringify(workpad.terminals)).not.toContain(rawRequest.id);
    const parts = await drain(started.stream);
    expect(parts.map((part) => part.type)).toContain("error");
    expect(process.requestFor("thread/resume")).toBeUndefined();
  });

  it("fails closed when a resumed thread response crosses the session identity", async () => {
    const workpad = new FakeWorkpad({ thread_id: "thread-54" });
    const process = new FakeDirectProcess({ thread_id: "thread-other" });
    const runtime = new FakeHostRuntime([process]);
    const resolveModel = createResolver(workpad, runtime);
    const resolved = await resolveModel(delegationMessages());
    const model = resolved.model as unknown as {
      doStream(input: unknown): Promise<{ stream: ReadableStream<unknown> }>;
    };

    await expect(model.doStream(streamOptions())).rejects.toThrow(
      "different persistent thread",
    );
    expect(process.requestFor("thread/resume")?.params).toEqual(
      expect.objectContaining({ threadId: "thread-54", cwd: worktreePath }),
    );
    expect(runtime.starts).toEqual([
      { executable: backend.codex_path, cwd: worktreePath },
    ]);
  });

  it("fails closed when the App Server rebinds a session to another worktree", async () => {
    const workpad = new FakeWorkpad();
    const process = new FakeDirectProcess({
      cwd: "/root/.eve/sandbox-cache/worktrees/diagnostic-other",
    });
    const runtime = new FakeHostRuntime([process]);
    const resolveModel = createResolver(workpad, runtime);
    const resolved = await resolveModel(delegationMessages());
    const model = resolved.model as unknown as {
      doStream(input: unknown): Promise<{ stream: ReadableStream<unknown> }>;
    };

    await expect(model.doStream(streamOptions())).rejects.toThrow(
      "Root-owned diagnostic worktree",
    );
    expect(process.requestFor("turn/start")).toBeUndefined();
    expect(runtime.starts).toEqual([
      { executable: backend.codex_path, cwd: worktreePath },
    ]);
  });

  it("fails closed if the App Server widens the diagnostic sandbox", async () => {
    const workpad = new FakeWorkpad();
    const process = new FakeDirectProcess({
      sandbox: { type: "dangerFullAccess" },
    });
    const runtime = new FakeHostRuntime([process]);
    const resolveModel = createResolver(workpad, runtime);
    const resolved = await resolveModel(delegationMessages());
    const model = resolved.model as unknown as {
      doStream(input: unknown): Promise<{ stream: ReadableStream<unknown> }>;
    };

    await expect(model.doStream(streamOptions())).rejects.toThrow(
      "workspace-write diagnostic sandbox",
    );
    expect(process.requestFor("turn/start")).toBeUndefined();
  });
});

async function startModel(
  workpad: FakeWorkpad,
  process: FakeDirectProcess,
  timers?: FakeTimers,
): Promise<{
  runtime: FakeHostRuntime;
  stream: ReadableStream<unknown>;
}> {
  const runtime = new FakeHostRuntime([process]);
  const resolveModel = createResolver(workpad, runtime, timers);
  const resolved = await resolveModel(delegationMessages());
  const model = resolved.model as unknown as {
    doStream(input: unknown): Promise<{ stream: ReadableStream<unknown> }>;
  };
  const result = await model.doStream(streamOptions());
  return { runtime, stream: result.stream };
}

function createResolver(
  workpad: FakeWorkpad,
  runtime: FakeHostRuntime,
  timers?: FakeTimers,
) {
  return createCodexAppServerModelResolver(backend, {
    diagnostic_session_workpad: workpad as unknown as DiagnosticSessionWorkpad,
    host_runtime: runtime,
    create_native_approval_broker: createBrokerFactory(timers),
  });
}

function createBrokerFactory(timers?: FakeTimers) {
  let approval = 0;
  return (input: Parameters<typeof createDiagnosticNativeApprovalBroker>[0]) =>
    createDiagnosticNativeApprovalBroker({
      ...input,
      now: () => "2026-07-20T15:33:00Z",
      create_approval_id: () => "native-approval-" + String(++approval),
      ...(timers
        ? {
            schedule_timeout: timers.schedule,
            clear_timeout: timers.clear,
          }
        : {}),
    });
}

function delegationMessages() {
  return [
    {
      role: "user" as const,
      content: renderDiagnosticSessionEnvelope(envelope),
    },
  ];
}

function streamOptions() {
  return {
    prompt: [
      {
        role: "user",
        content: [
          { type: "text", text: renderDiagnosticSessionEnvelope(envelope) },
        ],
      },
    ],
  };
}

function commandApprovalRequest(id: string): CodexAppServerServerRequest {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-54",
      turnId: "turn-54",
      itemId: "command-54",
      command: "curl https://example.invalid?token=hidden",
      cwd: "/private/raw-approval-cwd",
    },
  };
}

function autoReview(status: "approved" | "denied" | "timedOut") {
  return {
    method: "item/autoApprovalReview/completed",
    params: {
      threadId: "thread-54",
      turnId: "turn-54",
      targetItemId: "command-54",
      reviewId: "review-54",
      review: { status },
      action: { type: "command" },
    },
  };
}

async function completeTurn(process: FakeDirectProcess): Promise<void> {
  await process.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-54",
      turn: { id: "turn-54", status: "completed" },
    },
  });
}

async function drain(
  stream: ReadableStream<unknown>,
): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader();
  const parts: Array<Record<string, unknown>> = [];
  while (true) {
    const next = await reader.read();
    if (next.done) {
      return parts;
    }
    if (typeof next.value === "object" && next.value !== null) {
      parts.push(next.value as Record<string, unknown>);
    }
  }
}

class FakeWorkpad {
  private threadId: string | undefined;
  readonly terminals: NativeApprovalTerminalEvidence[] = [];
  readonly completions: Array<{
    thread_id: string;
    provider_finish_reason: string | undefined;
  }> = [];

  constructor(options: { thread_id?: string } = {}) {
    this.threadId = options.thread_id;
  }

  async loadForDiagnosticSession(_envelope: DiagnosticSessionEnvelope) {
    return {
      diagnostic_session: {
        state: {
          worktree: { path: worktreePath, identity: "diagnostic-54" },
          ...(this.threadId ? { codex_thread_id: this.threadId } : {}),
        },
      },
    };
  }

  async recordThread(_envelope: DiagnosticSessionEnvelope, threadId: string) {
    if (this.threadId && this.threadId !== threadId) {
      throw new Error("Workpad already owns a different persistent thread.");
    }
    this.threadId = threadId;
  }

  async loadNativeApprovalSessionBinding(_envelope: DiagnosticSessionEnvelope) {
    if (!this.threadId) {
      throw new Error(
        "Native approval requires a persisted diagnostic thread.",
      );
    }
    return {
      report_id: envelope.report_id,
      repository: envelope.repository,
      issue_number: envelope.issue_number,
      backend_id: backend.kind,
      diagnostic_session_identity: "diagnostic-54",
      worktree_identity: "diagnostic-54",
      persistent_thread_id: this.threadId,
    };
  }

  async recordNativeApprovalTerminal(
    _envelope: DiagnosticSessionEnvelope,
    _binding: unknown,
    evidence: NativeApprovalTerminalEvidence,
  ) {
    this.terminals.push(evidence);
  }

  async recordCompletion(
    _envelope: DiagnosticSessionEnvelope,
    threadId: string,
    _summary: string | undefined,
    providerFinishReason: string | undefined,
  ) {
    this.completions.push({
      thread_id: threadId,
      provider_finish_reason: providerFinishReason,
    });
  }
}

class FakeHostRuntime implements DirectCodexAppServerHostRuntime {
  readonly starts: Array<{ executable: string; cwd: string }> = [];

  constructor(private readonly processes: FakeDirectProcess[]) {}

  startAppServer(input: {
    executable: string;
    cwd: string;
  }): FakeDirectProcess {
    this.starts.push(input);
    const process = this.processes.shift();
    if (!process) {
      throw new Error("No fake App Server process remains.");
    }
    return process;
  }
}

class FakeDirectProcess implements DirectCodexAppServerProcess {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{
    id: CodexAppServerRequestId;
    result?: unknown;
    error?: { code: number; message: string };
  }> = [];
  disposeCount = 0;
  private readonly notificationHandlers = new Set<
    (notification: CodexAppServerNotification) => void | Promise<void>
  >();
  private readonly serverRequestHandlers = new Set<
    (request: CodexAppServerServerRequest) => void | Promise<void>
  >();
  private readonly closeHandlers = new Set<
    (error: Error) => void | Promise<void>
  >();
  private readonly threadId: string;
  private readonly turnId: string;

  constructor(
    options: {
      thread_id?: string;
      turn_id?: string;
      early_agent_delta?: string;
      cwd?: string;
      sandbox?: unknown;
    } = {},
  ) {
    this.threadId = options.thread_id ?? "thread-54";
    this.turnId = options.turn_id ?? "turn-54";
    this.earlyAgentDelta = options.early_agent_delta;
    this.threadCwd = options.cwd;
    this.threadSandbox = options.sandbox;
  }

  private readonly earlyAgentDelta: string | undefined;
  private readonly threadCwd: string | undefined;
  private readonly threadSandbox: unknown;

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "initialize" || method === "turn/interrupt") {
      return {};
    }
    if (method === "thread/start" || method === "thread/resume") {
      const values = record(params);
      return {
        thread: { id: this.threadId },
        cwd: this.threadCwd ?? values.cwd,
        approvalPolicy: values.approvalPolicy,
        approvalsReviewer: values.approvalsReviewer,
        sandbox: this.threadSandbox ?? { type: "workspaceWrite" },
      };
    }
    if (method === "turn/start") {
      if (this.earlyAgentDelta) {
        await this.emitNotification({
          method: "item/agentMessage/delta",
          params: {
            threadId: this.threadId,
            turnId: this.turnId,
            itemId: "message-54",
            delta: this.earlyAgentDelta,
          },
        });
      }
      return { turn: { id: this.turnId, status: "inProgress" } };
    }
    throw new Error("Unexpected App Server request: " + method);
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  respond(id: CodexAppServerRequestId, result: unknown): void {
    this.responses.push({ id, result });
  }

  respondError(
    id: CodexAppServerRequestId,
    code: number,
    message: string,
  ): void {
    this.responses.push({ id, error: { code, message } });
  }

  onNotification(
    handler: (notification: CodexAppServerNotification) => void | Promise<void>,
  ): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(
    handler: (request: CodexAppServerServerRequest) => void | Promise<void>,
  ): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onClose(handler: (error: Error) => void | Promise<void>): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }

  requestFor(method: string): { method: string; params: unknown } | undefined {
    return this.requests.find((request) => request.method === method);
  }

  async emitNotification(
    notification: CodexAppServerNotification,
  ): Promise<void> {
    for (const handler of this.notificationHandlers) {
      await handler(notification);
    }
  }

  async emitServerRequest(request: CodexAppServerServerRequest): Promise<void> {
    for (const handler of this.serverRequestHandlers) {
      await handler(request);
    }
  }

  async close(error: Error): Promise<void> {
    for (const handler of this.closeHandlers) {
      await handler(error);
    }
  }
}

class FakeTimers {
  private readonly callbacks: Array<() => void> = [];

  readonly schedule = (callback: () => void, _timeoutMs: number): unknown => {
    this.callbacks.push(callback);
    return callback;
  };

  readonly clear = (timer: unknown): void => {
    const index = this.callbacks.indexOf(timer as () => void);
    if (index >= 0) {
      this.callbacks.splice(index, 1);
    }
  };

  async fireNext(): Promise<void> {
    const callback = this.callbacks.shift();
    if (!callback) {
      throw new Error("Expected a scheduled native approval timeout.");
    }
    callback();
    await Promise.resolve();
    await Promise.resolve();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected an App Server parameter object.");
  }
  return value as Record<string, unknown>;
}
