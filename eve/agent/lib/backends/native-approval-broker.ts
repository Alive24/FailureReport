import { randomUUID } from "node:crypto";

import type { NativeApprovalTerminalEvidence } from "@failure-report/protocol";

import type { DiagnosticSessionWorkpad } from "../diagnostics/workpad.js";
import type { DiagnosticSessionEnvelope } from "../diagnostics/envelope.js";

const defaultNativeApprovalTimeoutMs = 30_000;
const maximumNativeApprovalTimeoutMs = 5 * 60_000;
const defaultCompletedRequestCacheSize = 64;

/**
 * Immutable session identity a managed backend must present with each native
 * approval. `persistent_thread_id` is live-only here; terminal evidence never
 * repeats it because the verified diagnostic session already owns that value.
 */
export type NativeApprovalSessionBinding = {
  report_id: string;
  repository: string;
  issue_number: number;
  backend_id: string;
  diagnostic_session_identity: string;
  worktree_identity: string;
  persistent_thread_id: string;
};

/** Provider-neutral classification used only while the native request is live. */
export type NativeApprovalRequestKind =
  "command_execution" | "file_change" | "permissions" | "other";

/**
 * Normalized, transient native-approval request.
 *
 * `provider_request_id` may be a raw provider JSON-RPC id. It is deliberately
 * restricted to broker memory and never appears in a terminal evidence value.
 * Command text, cwd, arguments, tokens, and connection details stay with the
 * backend adapter and are not accepted by this contract.
 */
export type NativeApprovalRequest = {
  provider_request_id: string;
  kind: NativeApprovalRequestKind;
  turn_id: string;
  session: NativeApprovalSessionBinding;
};

/** The narrow response a backend policy may ask the broker to deliver. */
export type NativeApprovalResponse = {
  decision: "approve" | "deny";
};

/** Live adapter callback that maps a normalized decision back to its protocol. */
export type NativeApprovalResponder = (
  response: NativeApprovalResponse,
) => Promise<void>;

/** One incoming native request and its connection-local response callback. */
export type NativeApprovalIncomingRequest = {
  request: NativeApprovalRequest;
  respond: NativeApprovalResponder;
};

/**
 * Durable boundary needed by the generic broker. It receives only sanitized
 * terminal facts, never a provider request id or an approval payload.
 */
export type NativeApprovalJournal = {
  isCurrent(binding: NativeApprovalSessionBinding): Promise<boolean>;
  recordTerminal(evidence: NativeApprovalTerminalEvidence): Promise<void>;
};

/** A registered live request can be resolved once or cleared by the backend. */
export type NativeApprovalRegistration = {
  status: "registered";
  resolve(response: NativeApprovalResponse): Promise<NativeApprovalTerminal>;
  cancel(): Promise<NativeApprovalTerminal>;
};

/** A rejected incoming request has already received a fail-closed response. */
export type NativeApprovalRejection = {
  status: "rejected";
  terminal: NativeApprovalTerminal;
};

/** Result of a terminal lifecycle action. */
export type NativeApprovalTerminal =
  | {
      status: NativeApprovalTerminalEvidence["status"];
      evidence: NativeApprovalTerminalEvidence;
    }
  | {
      status: "denied";
      reason: "stale_request";
    };

/** Configuration seams used to make lifecycle behavior deterministic in tests. */
export type NativeApprovalBrokerOptions = {
  session: NativeApprovalSessionBinding;
  journal: NativeApprovalJournal;
  timeout_ms?: number;
  completed_request_cache_size?: number;
  now?: () => string;
  create_approval_id?: () => string;
  schedule_timeout?: (callback: () => void, timeoutMs: number) => unknown;
  clear_timeout?: (timer: unknown) => void;
};

/** Signals that a terminal decision could not be made durable without leaking details. */
export class NativeApprovalBrokerError extends Error {
  constructor(
    message = "Native approval terminal evidence could not be recorded.",
  ) {
    super(message);
    this.name = "NativeApprovalBrokerError";
  }
}

type LiveNativeApproval = {
  approval_id: string;
  request: NativeApprovalRequest;
  respond: NativeApprovalResponder;
  lease: object;
  timer?: unknown;
};

type TerminalInput = {
  status: NativeApprovalTerminalEvidence["status"];
  decision?: NativeApprovalResponse["decision"];
  reason?: NonNullable<NativeApprovalTerminalEvidence["reason"]>;
  send_deny?: boolean;
};

/**
 * Owns one live native approval at a time for exactly one verified diagnostic
 * session. The broker is internal backend runtime infrastructure: it neither
 * evaluates policy nor exposes an outer continuation or approval API.
 */
export class NativeApprovalBroker {
  private readonly session: NativeApprovalSessionBinding;
  private readonly journal: NativeApprovalJournal;
  private readonly timeoutMs: number;
  private readonly completedRequestCacheSize: number;
  private readonly now: () => string;
  private readonly createApprovalId: () => string;
  private readonly scheduleTimeout: (
    callback: () => void,
    timeoutMs: number,
  ) => unknown;
  private readonly clearTimeout: (timer: unknown) => void;
  private readonly completedRequestIds = new Set<string>();
  private readonly completedRequestOrder: string[] = [];
  private active: LiveNativeApproval | undefined;
  private interrupted = false;

  constructor(options: NativeApprovalBrokerOptions) {
    assertValidBinding(options.session);
    this.session = options.session;
    this.journal = options.journal;
    this.timeoutMs = options.timeout_ms ?? defaultNativeApprovalTimeoutMs;
    this.completedRequestCacheSize =
      options.completed_request_cache_size ?? defaultCompletedRequestCacheSize;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createApprovalId =
      options.create_approval_id ?? (() => "native-approval/" + randomUUID());
    this.scheduleTimeout =
      options.schedule_timeout ??
      ((callback, timeoutMs) => setTimeout(callback, timeoutMs));
    this.clearTimeout =
      options.clear_timeout ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > maximumNativeApprovalTimeoutMs
    ) {
      throw new Error(
        "Native approval timeout must be a positive bounded integer.",
      );
    }
    if (
      !Number.isSafeInteger(this.completedRequestCacheSize) ||
      this.completedRequestCacheSize < 1
    ) {
      throw new Error(
        "Native approval completed request cache size must be a positive integer.",
      );
    }
  }

  /**
   * Registers one provider request after matching all immutable session
   * bindings. A concurrent or stale request is denied without replacing the
   * existing live request.
   */
  async register(
    incoming: NativeApprovalIncomingRequest,
  ): Promise<NativeApprovalRegistration | NativeApprovalRejection> {
    const request = incoming.request;
    if (
      !isWellFormedRequest(request) ||
      !sameBinding(request.session, this.session)
    ) {
      return {
        status: "rejected",
        terminal: await this.rejectIncoming(incoming, "identity_mismatch"),
      };
    }
    if (this.interrupted) {
      return {
        status: "rejected",
        terminal: await this.rejectIncoming(incoming, "process_interrupted"),
      };
    }

    if (this.active) {
      if (
        this.active.request.provider_request_id === request.provider_request_id
      ) {
        const terminal = await this.terminalize(this.active, {
          status: "denied",
          reason: "duplicate_request",
          send_deny: true,
        });
        return { status: "rejected", terminal };
      }
      return {
        status: "rejected",
        terminal: await this.rejectIncoming(incoming, "concurrent_request"),
      };
    }

    if (this.completedRequestIds.has(request.provider_request_id)) {
      return {
        status: "rejected",
        terminal: await this.rejectIncoming(incoming, "duplicate_request"),
      };
    }

    if (!(await this.sessionIsCurrent())) {
      return {
        status: "rejected",
        terminal: await this.rejectIncoming(incoming, "stale_session"),
      };
    }

    const approvalId = this.nextApprovalId();
    const lease = {};
    const live: LiveNativeApproval = {
      approval_id: approvalId,
      request,
      respond: incoming.respond,
      lease,
    };
    live.timer = this.scheduleTimeout(() => {
      void this.timeout(lease).catch(() => undefined);
    }, this.timeoutMs);
    this.active = live;

    return {
      status: "registered",
      resolve: async (response) => this.resolve(lease, response),
      cancel: async () => this.cancel(lease),
    };
  }

  /**
   * Marks every current request interrupted before a process or connection is
   * discarded. A new process cannot safely replay the former live request.
   */
  async interrupt(): Promise<NativeApprovalTerminal | undefined> {
    this.interrupted = true;
    if (!this.active) {
      return undefined;
    }
    return this.terminalize(this.active, {
      status: "interrupted",
      reason: "process_interrupted",
      send_deny: true,
    });
  }

  private async resolve(
    lease: object,
    response: NativeApprovalResponse,
  ): Promise<NativeApprovalTerminal> {
    const active = this.active;
    if (!active || active.lease !== lease) {
      return { status: "denied", reason: "stale_request" };
    }
    if (!isResponse(response) || !(await this.sessionIsCurrent())) {
      return this.terminalize(active, {
        status: "denied",
        reason: "stale_session",
        send_deny: true,
      });
    }
    return this.terminalize(active, {
      status: "resolved",
      decision: response.decision,
    });
  }

  /** Handles a backend `serverRequest/resolved`-style cleanup without replying. */
  private async cancel(lease: object): Promise<NativeApprovalTerminal> {
    const active = this.active;
    if (!active || active.lease !== lease) {
      return { status: "denied", reason: "stale_request" };
    }
    return this.terminalize(active, {
      status: "cancelled",
      reason: "cancelled_by_backend",
    });
  }

  private async timeout(lease: object): Promise<NativeApprovalTerminal> {
    const active = this.active;
    if (!active || active.lease !== lease) {
      return { status: "denied", reason: "stale_request" };
    }
    return this.terminalize(active, {
      status: "timed_out",
      reason: "timeout",
      send_deny: true,
    });
  }

  private async rejectIncoming(
    incoming: NativeApprovalIncomingRequest,
    reason: NonNullable<NativeApprovalTerminalEvidence["reason"]>,
  ): Promise<NativeApprovalTerminal> {
    const request = isWellFormedRequest(incoming.request)
      ? incoming.request
      : undefined;
    const evidence = this.createTerminalEvidence({
      approval_id: this.nextApprovalId(),
      turn_id: request?.turn_id,
      status: reason === "process_interrupted" ? "interrupted" : "denied",
      reason,
    });
    this.rememberRequest(request?.provider_request_id ?? "");
    try {
      await incoming.respond({ decision: "deny" });
    } catch {
      const failed = this.createTerminalEvidence({
        approval_id: evidence.approval_id,
        turn_id: evidence.turn_id,
        status: "interrupted",
        reason: "response_delivery_failed",
      });
      await this.recordTerminal(failed);
      return { status: failed.status, evidence: failed };
    }
    await this.recordTerminal(evidence);
    return { status: evidence.status, evidence };
  }

  private async terminalize(
    active: LiveNativeApproval,
    input: TerminalInput,
  ): Promise<NativeApprovalTerminal> {
    if (this.active?.lease !== active.lease) {
      return { status: "denied", reason: "stale_request" };
    }
    this.active = undefined;
    if (active.timer !== undefined) {
      this.clearTimeout(active.timer);
    }
    this.rememberRequest(active.request.provider_request_id);

    const evidence = this.createTerminalEvidence({
      approval_id: active.approval_id,
      turn_id: active.request.turn_id,
      status: input.status,
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });

    // Persist a positive decision before handing it to a live backend. If the
    // durable boundary is unavailable, the backend receives only a denial.
    if (input.decision === "approve") {
      await this.recordTerminal(evidence);
      try {
        await active.respond({ decision: "approve" });
      } catch {
        throw new NativeApprovalBrokerError(
          "Native approval response delivery failed after a durable decision.",
        );
      }
      return { status: evidence.status, evidence };
    }

    if (input.decision === "deny" || input.send_deny) {
      try {
        await active.respond({ decision: "deny" });
      } catch {
        const failed = this.createTerminalEvidence({
          approval_id: active.approval_id,
          turn_id: active.request.turn_id,
          status: "interrupted",
          reason: "response_delivery_failed",
        });
        await this.recordTerminal(failed);
        return { status: failed.status, evidence: failed };
      }
    }

    await this.recordTerminal(evidence);
    return { status: evidence.status, evidence };
  }

  private async sessionIsCurrent(): Promise<boolean> {
    try {
      return await this.journal.isCurrent(this.session);
    } catch {
      return false;
    }
  }

  private async recordTerminal(
    evidence: NativeApprovalTerminalEvidence,
  ): Promise<void> {
    try {
      await this.journal.recordTerminal(evidence);
    } catch {
      throw new NativeApprovalBrokerError();
    }
  }

  private createTerminalEvidence(input: {
    approval_id: string;
    turn_id?: string;
    status: NativeApprovalTerminalEvidence["status"];
    decision?: NativeApprovalResponse["decision"];
    reason?: NonNullable<NativeApprovalTerminalEvidence["reason"]>;
  }): NativeApprovalTerminalEvidence {
    return {
      schema_version: "failure-report/native-approval-terminal/v1",
      approval_id: input.approval_id,
      backend_id: this.session.backend_id,
      diagnostic_session_identity: this.session.diagnostic_session_identity,
      ...(input.turn_id ? { turn_id: input.turn_id } : {}),
      status: input.status,
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      recorded_at: this.now(),
    };
  }

  private nextApprovalId(): string {
    const approvalId = this.createApprovalId();
    if (!isSafeIdentifier(approvalId)) {
      throw new Error("Native approval ids must be stable safe identifiers.");
    }
    return approvalId;
  }

  private rememberRequest(requestId: string): void {
    if (!requestId || this.completedRequestIds.has(requestId)) {
      return;
    }
    this.completedRequestIds.add(requestId);
    this.completedRequestOrder.push(requestId);
    if (this.completedRequestOrder.length > this.completedRequestCacheSize) {
      const expired = this.completedRequestOrder.shift();
      if (expired) {
        this.completedRequestIds.delete(expired);
      }
    }
  }
}

/**
 * Binds the generic broker to the Root-owned workpad without giving callers a
 * workpad mutation surface. The workpad verifies the active worktree and
 * persistent thread on each decision before it accepts terminal evidence.
 */
export async function createDiagnosticNativeApprovalBroker(input: {
  workpad: Pick<
    DiagnosticSessionWorkpad,
    "loadNativeApprovalSessionBinding" | "recordNativeApprovalTerminal"
  >;
  envelope: DiagnosticSessionEnvelope;
  timeout_ms?: number;
  completed_request_cache_size?: number;
  now?: () => string;
  create_approval_id?: () => string;
  schedule_timeout?: (callback: () => void, timeoutMs: number) => unknown;
  clear_timeout?: (timer: unknown) => void;
}): Promise<NativeApprovalBroker> {
  const binding = await input.workpad.loadNativeApprovalSessionBinding(
    input.envelope,
  );
  return new NativeApprovalBroker({
    session: binding,
    journal: {
      async isCurrent(expected) {
        const current = await input.workpad.loadNativeApprovalSessionBinding(
          input.envelope,
        );
        return sameBinding(expected, current);
      },
      async recordTerminal(evidence) {
        await input.workpad.recordNativeApprovalTerminal(
          input.envelope,
          binding,
          evidence,
        );
      },
    },
    ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
    ...(input.completed_request_cache_size !== undefined
      ? { completed_request_cache_size: input.completed_request_cache_size }
      : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.create_approval_id
      ? { create_approval_id: input.create_approval_id }
      : {}),
    ...(input.schedule_timeout
      ? { schedule_timeout: input.schedule_timeout }
      : {}),
    ...(input.clear_timeout ? { clear_timeout: input.clear_timeout } : {}),
  });
}

function assertValidBinding(binding: NativeApprovalSessionBinding): void {
  if (!isValidBinding(binding)) {
    throw new Error(
      "Native approval broker requires one validated session binding.",
    );
  }
}

function isWellFormedRequest(value: unknown): value is NativeApprovalRequest {
  if (!isRecord(value) || !isValidBinding(value.session)) {
    return false;
  }
  return (
    typeof value.provider_request_id === "string" &&
    value.provider_request_id.length > 0 &&
    value.provider_request_id.length <= 1_024 &&
    isSafeIdentifier(value.turn_id) &&
    ["command_execution", "file_change", "permissions", "other"].includes(
      value.kind as string,
    )
  );
}

function isResponse(value: unknown): value is NativeApprovalResponse {
  return (
    isRecord(value) &&
    (value.decision === "approve" || value.decision === "deny")
  );
}

function sameBinding(
  left: unknown,
  right: NativeApprovalSessionBinding,
): boolean {
  if (!isValidBinding(left)) {
    return false;
  }
  return (
    left.report_id === right.report_id &&
    left.repository === right.repository &&
    left.issue_number === right.issue_number &&
    left.backend_id === right.backend_id &&
    left.diagnostic_session_identity === right.diagnostic_session_identity &&
    left.worktree_identity === right.worktree_identity &&
    left.persistent_thread_id === right.persistent_thread_id
  );
}

function isValidBinding(value: unknown): value is NativeApprovalSessionBinding {
  return (
    isRecord(value) &&
    isSafeIdentifier(value.report_id) &&
    typeof value.repository === "string" &&
    /^[^/\s]+\/[^/\s]+$/.test(value.repository) &&
    typeof value.issue_number === "number" &&
    Number.isSafeInteger(value.issue_number) &&
    value.issue_number > 0 &&
    isSafeIdentifier(value.backend_id) &&
    isSafeIdentifier(value.diagnostic_session_identity) &&
    isSafeIdentifier(value.worktree_identity) &&
    value.diagnostic_session_identity === value.worktree_identity &&
    typeof value.persistent_thread_id === "string" &&
    value.persistent_thread_id.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)
  );
}
