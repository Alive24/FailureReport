import { describe, expect, it } from "vitest";

import type { NativeApprovalTerminalEvidence } from "@failure-report/protocol";

import {
  NativeApprovalBroker,
  type NativeApprovalIncomingRequest,
  type NativeApprovalJournal,
  type NativeApprovalRegistration,
  type NativeApprovalSessionBinding,
} from "../agent/lib/backends/native-approval-broker.js";

const session: NativeApprovalSessionBinding = {
  report_id: "report-54",
  repository: "Alive24/CKBoost",
  issue_number: 54,
  backend_id: "codex_app_server",
  diagnostic_session_identity: "diagnostic-54",
  worktree_identity: "diagnostic-54",
  persistent_thread_id: "thread-54",
};

/** Deterministic fake backend coverage for the native approval lifecycle. */
describe("native approval broker", () => {
  it("resolves approved and denied requests once while retaining only sanitized terminal facts", async () => {
    const journal = new FakeApprovalJournal();
    const broker = createBroker(journal);
    const rawProviderRequest = {
      id: "json-rpc-request-54",
      command: "curl https://example.invalid?token=not-for-workpad",
      cwd: "/private/diagnostic-worktree",
      arguments: ["--header", "Authorization: Bearer hidden"],
      connection: "stdio://private-host",
    };
    const approved = incoming({
      provider_request_id: rawProviderRequest.id,
      turn_id: "turn-54",
    });
    const approvedRegistration = registered(
      await broker.register(approved.input),
    );

    await expect(
      approvedRegistration.resolve({ decision: "approve" }),
    ).resolves.toMatchObject({
      status: "resolved",
      evidence: { decision: "approve", approval_id: "native-approval-1" },
    });
    expect(approved.responses).toEqual([{ decision: "approve" }]);

    const denied = incoming({
      provider_request_id: "json-rpc-request-55",
      turn_id: "turn-55",
    });
    const deniedRegistration = registered(await broker.register(denied.input));
    await expect(
      deniedRegistration.resolve({ decision: "deny" }),
    ).resolves.toMatchObject({
      status: "resolved",
      evidence: { decision: "deny", approval_id: "native-approval-2" },
    });
    expect(denied.responses).toEqual([{ decision: "deny" }]);

    expect(journal.terminals).toEqual([
      expect.objectContaining({
        approval_id: "native-approval-1",
        backend_id: "codex_app_server",
        diagnostic_session_identity: "diagnostic-54",
        turn_id: "turn-54",
        status: "resolved",
        decision: "approve",
      }),
      expect.objectContaining({
        approval_id: "native-approval-2",
        turn_id: "turn-55",
        status: "resolved",
        decision: "deny",
      }),
    ]);
    const persistedWorkpad = JSON.stringify(journal.terminals);
    expect(persistedWorkpad).not.toContain(rawProviderRequest.id);
    expect(persistedWorkpad).not.toContain(rawProviderRequest.command);
    expect(persistedWorkpad).not.toContain(rawProviderRequest.cwd);
    expect(persistedWorkpad).not.toContain(rawProviderRequest.arguments[1]);
    expect(persistedWorkpad).not.toContain(rawProviderRequest.connection);
    expect(persistedWorkpad).not.toContain(session.persistent_thread_id);
  });

  it("denies duplicate requests without allowing a second live owner", async () => {
    const journal = new FakeApprovalJournal();
    const broker = createBroker(journal);
    const original = incoming({
      provider_request_id: "duplicate-request",
      turn_id: "turn-54",
    });
    const originalRegistration = registered(
      await broker.register(original.input),
    );
    const duplicate = incoming({
      provider_request_id: "duplicate-request",
      turn_id: "turn-54",
    });

    await expect(broker.register(duplicate.input)).resolves.toMatchObject({
      status: "rejected",
      terminal: {
        status: "denied",
        evidence: { reason: "duplicate_request" },
      },
    });
    expect(original.responses).toEqual([{ decision: "deny" }]);
    expect(duplicate.responses).toEqual([]);
    await expect(
      originalRegistration.resolve({ decision: "approve" }),
    ).resolves.toEqual({ status: "denied", reason: "stale_request" });
    expect(journal.terminals).toHaveLength(1);
  });

  it("fails closed for mismatched or stale session bindings", async () => {
    const journal = new FakeApprovalJournal();
    const broker = createBroker(journal);
    const mismatched = incoming({
      provider_request_id: "mismatched-request",
      turn_id: "turn-54",
      session: { ...session, persistent_thread_id: "thread-other" },
    });

    await expect(broker.register(mismatched.input)).resolves.toMatchObject({
      status: "rejected",
      terminal: {
        status: "denied",
        evidence: { reason: "identity_mismatch" },
      },
    });
    expect(mismatched.responses).toEqual([{ decision: "deny" }]);
    expect(JSON.stringify(journal.terminals)).not.toContain("thread-other");

    const active = incoming({
      provider_request_id: "stale-request",
      turn_id: "turn-55",
    });
    const activeRegistration = registered(await broker.register(active.input));
    journal.current = false;
    await expect(
      activeRegistration.resolve({ decision: "approve" }),
    ).resolves.toMatchObject({
      status: "denied",
      evidence: { reason: "stale_session" },
    });
    expect(active.responses).toEqual([{ decision: "deny" }]);
  });

  it("records cancellation and timeout as distinct safe terminal states", async () => {
    const journal = new FakeApprovalJournal();
    const timers = new FakeTimers();
    const broker = createBroker(journal, timers);
    const cancelled = incoming({
      provider_request_id: "cancelled-request",
      turn_id: "turn-54",
    });
    const cancellation = registered(await broker.register(cancelled.input));

    await expect(cancellation.cancel()).resolves.toMatchObject({
      status: "cancelled",
      evidence: { reason: "cancelled_by_backend" },
    });
    expect(cancelled.responses).toEqual([]);

    const timedOut = incoming({
      provider_request_id: "timed-out-request",
      turn_id: "turn-55",
    });
    registered(await broker.register(timedOut.input));
    timers.fireNext();
    await timers.drain();

    expect(timedOut.responses).toEqual([{ decision: "deny" }]);
    expect(journal.terminals.at(-1)).toMatchObject({
      status: "timed_out",
      reason: "timeout",
    });
  });

  it("interrupts a process-owned request and rejects later registrations", async () => {
    const journal = new FakeApprovalJournal();
    const broker = createBroker(journal);
    const interrupted = incoming({
      provider_request_id: "interrupted-request",
      turn_id: "turn-54",
    });
    registered(await broker.register(interrupted.input));

    await expect(broker.interrupt()).resolves.toMatchObject({
      status: "interrupted",
      evidence: { reason: "process_interrupted" },
    });
    expect(interrupted.responses).toEqual([{ decision: "deny" }]);

    const afterInterruption = incoming({
      provider_request_id: "after-interruption",
      turn_id: "turn-55",
    });
    await expect(
      broker.register(afterInterruption.input),
    ).resolves.toMatchObject({
      status: "rejected",
      terminal: {
        status: "interrupted",
        evidence: { reason: "process_interrupted" },
      },
    });
    expect(afterInterruption.responses).toEqual([{ decision: "deny" }]);
  });
});

function createBroker(
  journal: FakeApprovalJournal,
  timers?: FakeTimers,
): NativeApprovalBroker {
  let identifier = 0;
  return new NativeApprovalBroker({
    session,
    journal,
    now: () => "2026-07-20T14:53:00Z",
    create_approval_id: () => "native-approval-" + String(++identifier),
    ...(timers
      ? {
          schedule_timeout: timers.schedule,
          clear_timeout: timers.clear,
        }
      : {}),
  });
}

function incoming(input: {
  provider_request_id: string;
  turn_id: string;
  session?: NativeApprovalSessionBinding;
}): {
  input: NativeApprovalIncomingRequest;
  responses: Array<{ decision: "approve" | "deny" }>;
} {
  const responses: Array<{ decision: "approve" | "deny" }> = [];
  return {
    input: {
      request: {
        provider_request_id: input.provider_request_id,
        kind: "command_execution",
        turn_id: input.turn_id,
        session: input.session ?? session,
      },
      async respond(response) {
        responses.push(response);
      },
    },
    responses,
  };
}

function registered(
  result:
    NativeApprovalRegistration | { status: "rejected"; terminal: unknown },
): NativeApprovalRegistration {
  if (result.status !== "registered") {
    throw new Error("Expected the fake backend request to register.");
  }
  return result;
}

class FakeApprovalJournal implements NativeApprovalJournal {
  current = true;
  readonly terminals: NativeApprovalTerminalEvidence[] = [];

  async isCurrent(): Promise<boolean> {
    return this.current;
  }

  async recordTerminal(
    evidence: NativeApprovalTerminalEvidence,
  ): Promise<void> {
    this.terminals.push(structuredClone(evidence));
  }
}

class FakeTimers {
  private readonly callbacks: Array<() => void> = [];

  readonly schedule = (callback: () => void): (() => void) => {
    this.callbacks.push(callback);
    return callback;
  };

  readonly clear = (timer: unknown): void => {
    const index = this.callbacks.indexOf(timer as () => void);
    if (index >= 0) {
      this.callbacks.splice(index, 1);
    }
  };

  fireNext(): void {
    const callback = this.callbacks.shift();
    if (!callback) {
      throw new Error("Expected a scheduled native approval timeout.");
    }
    callback();
  }

  async drain(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}
