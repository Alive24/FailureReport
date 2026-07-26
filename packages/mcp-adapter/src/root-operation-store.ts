import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { SessionState } from "eve/client";

import {
  rootRequestSchema,
  rootResultSchema,
  type RootRequest,
  type RootResult,
} from "@failure-report/protocol";

export type PreparedRootOperation = RootOperationBase & {
  state: "prepared";
  request: RootRequest;
  delivery_owner?: string;
  delivery_started_at?: string;
};

export type DeliveredRootOperation = RootOperationBase & {
  state: "delivered";
  request: RootRequest;
  delivery_owner: string;
  delivered_at: string;
  session_state: SessionState;
};

export type QueuedRootOperation = RootOperationBase & {
  state: "queued";
  request: RootRequest;
};

export type TerminalRootOperation = RootOperationBase & {
  state: "terminal";
  request: RootRequest;
  result: RootResult;
  completed_at: string;
};

export type CleanedRootOperation = RootOperationBase & {
  state: "cleaned";
  result: RootResult;
  completed_at: string;
  cleaned_at: string;
};

export type DurableRootOperation =
  | PreparedRootOperation
  | DeliveredRootOperation
  | QueuedRootOperation
  | TerminalRootOperation
  | CleanedRootOperation;

export type RootSessionOperationLedger = {
  session_state?: SessionState;
  active_request_id?: string;
  queue: string[];
  operations: Record<string, DurableRootOperation>;
  retired_request_filter?: string;
  blocked_reason?: string;
};

type RootOperationBase = {
  request_id: string;
  request_fingerprint: string;
  created_at: string;
  updated_at: string;
};

export type RootOperationStoreMutation<T> = {
  ledger: RootSessionOperationLedger;
  value: T;
};

/**
 * Adapter-private durable state boundary for one logical Root conversation.
 *
 * Mutations are synchronous so implementations can serialize the complete
 * read-modify-write transaction without holding a lock across external work.
 */
export interface RootOperationStore {
  readonly runtime_id: string;
  readLedger(key: string): Promise<RootSessionOperationLedger | undefined>;
  listSessionKeys(): Promise<string[]>;
  mutateLedger<T>(
    key: string,
    mutation: (
      ledger: RootSessionOperationLedger | undefined,
    ) => RootOperationStoreMutation<T>,
  ): Promise<T>;
}

/** In-process durable-state model used by tests and ephemeral MCP hosts. */
export class InMemoryRootSessionStore implements RootOperationStore {
  readonly runtime_id: string = randomUUID();
  private readonly entries = new Map<string, RootSessionOperationLedger>();
  private writeTail: Promise<void> = Promise.resolve();

  async readLedger(
    key: string,
  ): Promise<RootSessionOperationLedger | undefined> {
    const ledger = this.entries.get(key);
    return ledger ? structuredClone(ledger) : undefined;
  }

  async listSessionKeys(): Promise<string[]> {
    return [...this.entries.keys()];
  }

  /** @deprecated Use the operation-ledger methods for new adapter code. */
  async read(key: string): Promise<SessionState | undefined> {
    return (await this.readLedger(key))?.session_state;
  }

  /** @deprecated Cursor-only writes are allowed only while no operation is active. */
  async write(key: string, state: SessionState): Promise<void> {
    await this.mutateLedger(key, (existing) => {
      const ledger = existing ?? createRootSessionOperationLedger();
      if (ledger.active_request_id) {
        throw new Error(
          "Cannot apply a cursor-only write while a Root operation is active.",
        );
      }
      ledger.session_state = state;
      return { ledger, value: undefined };
    });
  }

  async mutateLedger<T>(
    key: string,
    mutation: (
      ledger: RootSessionOperationLedger | undefined,
    ) => RootOperationStoreMutation<T>,
  ): Promise<T> {
    let value!: T;
    const write = this.writeTail.then(() => {
      const current = this.entries.get(key);
      const result = mutation(current ? structuredClone(current) : undefined);
      assertRequestOwnership(key, result.ledger, this.entries);
      this.entries.set(key, structuredClone(result.ledger));
      value = result.value;
    });
    this.writeTail = write.catch(() => undefined);
    await write;
    return value;
  }
}

/**
 * User-private operation ledger used by the local MCP adapter across restarts.
 *
 * Version 1 cursor-only files are migrated in memory and rewritten as version 2
 * on the first mutation. Every write uses a synced temporary file plus rename so
 * a process failure cannot expose partially written operation ownership.
 */
export class FileRootSessionStore implements RootOperationStore {
  readonly runtime_id: string = randomUUID();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async readLedger(
    key: string,
  ): Promise<RootSessionOperationLedger | undefined> {
    const sessions = await this.readSessions();
    return sessions[key];
  }

  async listSessionKeys(): Promise<string[]> {
    return Object.keys(await this.readSessions());
  }

  /** @deprecated Use the operation-ledger methods for new adapter code. */
  async read(key: string): Promise<SessionState | undefined> {
    return (await this.readLedger(key))?.session_state;
  }

  /** @deprecated Cursor-only writes are allowed only while no operation is active. */
  async write(key: string, state: SessionState): Promise<void> {
    await this.mutateLedger(key, (existing) => {
      const ledger = existing ?? createRootSessionOperationLedger();
      if (ledger.active_request_id) {
        throw new Error(
          "Cannot apply a cursor-only write while a Root operation is active.",
        );
      }
      ledger.session_state = state;
      return { ledger, value: undefined };
    });
  }

  async mutateLedger<T>(
    key: string,
    mutation: (
      ledger: RootSessionOperationLedger | undefined,
    ) => RootOperationStoreMutation<T>,
  ): Promise<T> {
    let value!: T;
    const write = this.writeTail.then(async () => {
      const sessions = await this.readSessions();
      const prior = sessions[key];
      const result = mutation(prior ? structuredClone(prior) : undefined);
      assertRequestOwnership(key, result.ledger, sessions);
      if (sameLedger(prior, result.ledger)) {
        value = result.value;
        return;
      }
      sessions[key] = result.ledger;
      await writeDurableJson(this.filePath, {
        version: 2,
        sessions,
      });
      value = result.value;
    });
    this.writeTail = write.catch(() => undefined);
    await write;
    return value;
  }

  private async readSessions(): Promise<
    Record<string, RootSessionOperationLedger>
  > {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return {};
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        "FailureReport MCP operation store contains invalid JSON.",
      );
    }
    return parsePersistedRootSessions(parsed);
  }
}

/** Creates an empty ledger while preserving a previously migrated Eve cursor. */
export function createRootSessionOperationLedger(
  sessionState?: SessionState,
): RootSessionOperationLedger {
  return {
    ...(sessionState ? { session_state: sessionState } : {}),
    queue: [],
    operations: {},
  };
}

/** Parses both the cursor-only v1 file and the operation-ledger v2 file. */
function parsePersistedRootSessions(
  value: unknown,
): Record<string, RootSessionOperationLedger> {
  if (!isRecord(value)) {
    throw invalidStore();
  }

  if (value.version === 1 && isRecord(value.entries)) {
    const migrated: Record<string, RootSessionOperationLedger> = {};
    for (const [key, state] of Object.entries(value.entries)) {
      if (!isSessionState(state)) {
        throw invalidStore();
      }
      migrated[key] = createRootSessionOperationLedger(state);
    }
    return migrated;
  }

  if (value.version !== 2 || !isRecord(value.sessions)) {
    throw invalidStore();
  }

  const sessions: Record<string, RootSessionOperationLedger> = {};
  for (const [key, ledger] of Object.entries(value.sessions)) {
    sessions[key] = parseRootSessionOperationLedger(ledger);
  }
  validateCrossSessionOwnership(sessions);
  return sessions;
}

function parseRootSessionOperationLedger(
  value: unknown,
): RootSessionOperationLedger {
  if (
    !isRecord(value) ||
    !Array.isArray(value.queue) ||
    !value.queue.every((item) => typeof item === "string") ||
    new Set(value.queue).size !== value.queue.length ||
    !isRecord(value.operations) ||
    (value.session_state !== undefined &&
      !isSessionState(value.session_state)) ||
    (value.active_request_id !== undefined &&
      typeof value.active_request_id !== "string") ||
    (value.blocked_reason !== undefined &&
      (typeof value.blocked_reason !== "string" ||
        value.blocked_reason.length === 0)) ||
    (value.retired_request_filter !== undefined &&
      !isRetiredRequestFilter(value.retired_request_filter))
  ) {
    throw invalidStore();
  }

  const operations: Record<string, DurableRootOperation> = {};
  for (const [requestId, operation] of Object.entries(value.operations)) {
    const parsed = parseRootOperation(requestId, operation);
    operations[requestId] = parsed;
  }

  const queuedIds = new Set(value.queue);
  const activeIds: string[] = [];
  for (const requestId of value.queue) {
    if (operations[requestId]?.state !== "queued") {
      throw invalidStore();
    }
  }
  for (const operation of Object.values(operations)) {
    if (operation.state === "queued" && !queuedIds.has(operation.request_id)) {
      throw invalidStore();
    }
    if (operation.state === "prepared" || operation.state === "delivered") {
      activeIds.push(operation.request_id);
    }
  }

  if (value.active_request_id !== undefined) {
    const active = operations[value.active_request_id];
    if (active?.state !== "prepared" && active?.state !== "delivered") {
      throw invalidStore();
    }
    if (
      active.state === "delivered" &&
      (!value.session_state ||
        !sameSessionState(active.session_state, value.session_state))
    ) {
      throw invalidStore();
    }
  }
  if (
    activeIds.length !== (value.active_request_id === undefined ? 0 : 1) ||
    (activeIds.length === 1 && activeIds[0] !== value.active_request_id)
  ) {
    throw invalidStore();
  }

  return {
    ...(value.session_state
      ? { session_state: value.session_state as SessionState }
      : {}),
    ...(value.active_request_id
      ? { active_request_id: value.active_request_id }
      : {}),
    queue: [...value.queue],
    operations,
    ...(value.retired_request_filter
      ? { retired_request_filter: value.retired_request_filter as string }
      : {}),
    ...(value.blocked_reason
      ? { blocked_reason: value.blocked_reason as string }
      : {}),
  };
}

function parseRootOperation(
  requestId: string,
  value: unknown,
): DurableRootOperation {
  if (
    !isRecord(value) ||
    value.request_id !== requestId ||
    typeof value.request_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.request_fingerprint) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at)
  ) {
    throw invalidStore();
  }

  const base: RootOperationBase = {
    request_id: requestId,
    request_fingerprint: value.request_fingerprint,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
  const request = rootRequestSchema.safeParse(value.request);
  const result = rootResultSchema.safeParse(value.result);
  if (
    request.success &&
    rootRequestFingerprint(request.data) !== value.request_fingerprint
  ) {
    throw invalidStore();
  }

  switch (value.state) {
    case "queued":
      if (!request.success) throw invalidStore();
      return { ...base, state: "queued", request: request.data };
    case "prepared":
      if (
        !request.success ||
        (value.delivery_owner !== undefined &&
          (typeof value.delivery_owner !== "string" ||
            value.delivery_owner.length === 0)) ||
        (value.delivery_started_at !== undefined &&
          !isTimestamp(value.delivery_started_at)) ||
        (value.delivery_owner === undefined) !==
          (value.delivery_started_at === undefined)
      ) {
        throw invalidStore();
      }
      return {
        ...base,
        state: "prepared",
        request: request.data,
        ...(value.delivery_owner
          ? { delivery_owner: value.delivery_owner as string }
          : {}),
        ...(value.delivery_started_at
          ? { delivery_started_at: value.delivery_started_at as string }
          : {}),
      };
    case "delivered":
      if (
        !request.success ||
        typeof value.delivery_owner !== "string" ||
        value.delivery_owner.length === 0 ||
        !isTimestamp(value.delivered_at) ||
        !isSessionState(value.session_state) ||
        !value.session_state.sessionId
      ) {
        throw invalidStore();
      }
      return {
        ...base,
        state: "delivered",
        request: request.data,
        delivery_owner: value.delivery_owner,
        delivered_at: value.delivered_at,
        session_state: value.session_state,
      };
    case "terminal":
      if (
        !request.success ||
        !result.success ||
        result.data.request_id !== requestId ||
        !isTimestamp(value.completed_at)
      ) {
        throw invalidStore();
      }
      return {
        ...base,
        state: "terminal",
        request: request.data,
        result: result.data,
        completed_at: value.completed_at,
      };
    case "cleaned":
      if (
        !result.success ||
        result.data.request_id !== requestId ||
        !isTimestamp(value.completed_at) ||
        !isTimestamp(value.cleaned_at)
      ) {
        throw invalidStore();
      }
      return {
        ...base,
        state: "cleaned",
        result: result.data,
        completed_at: value.completed_at,
        cleaned_at: value.cleaned_at,
      };
    default:
      throw invalidStore();
  }
}

async function writeDurableJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = filePath + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);

    // Syncing the directory makes the rename durable on filesystems that
    // otherwise persist the file contents before the directory entry.
    const directory = await open(dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isRetiredRequestFilter(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    return (
      decoded.byteLength === retiredFilterBytes &&
      decoded.toString("base64") === value
    );
  } catch {
    return false;
  }
}

function sameSessionState(left: SessionState, right: SessionState): boolean {
  return (
    left.continuationToken === right.continuationToken &&
    left.sessionId === right.sessionId &&
    left.streamIndex === right.streamIndex
  );
}

function sameLedger(
  left: RootSessionOperationLedger | undefined,
  right: RootSessionOperationLedger,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

export const retiredFilterBytes = 8_192;

function validateCrossSessionOwnership(
  sessions: Record<string, RootSessionOperationLedger>,
): void {
  for (const [key, ledger] of Object.entries(sessions)) {
    assertRequestOwnership(key, ledger, sessions);
  }
}

function assertRequestOwnership(
  key: string,
  ledger: RootSessionOperationLedger,
  sessions:
    | ReadonlyMap<string, RootSessionOperationLedger>
    | Record<string, RootSessionOperationLedger>,
): void {
  for (const requestId of Object.keys(ledger.operations)) {
    for (const [otherKey, otherLedger] of sessionEntries(sessions)) {
      if (
        otherKey !== key &&
        (otherLedger.operations[requestId] ||
          retiredFilterHas(otherLedger.retired_request_filter, requestId))
      ) {
        throw invalidStore();
      }
    }
  }
}

function sessionEntries(
  sessions:
    | ReadonlyMap<string, RootSessionOperationLedger>
    | Record<string, RootSessionOperationLedger>,
): Iterable<[string, RootSessionOperationLedger]> {
  return sessions instanceof Map
    ? sessions.entries()
    : Object.entries(sessions);
}

function retiredFilterHas(
  encoded: string | undefined,
  requestId: string,
): boolean {
  if (!encoded) {
    return false;
  }
  const filter = Buffer.from(encoded, "base64");
  const digest = createHash("sha256").update(requestId, "utf8").digest();
  const bitCount = retiredFilterBytes * 8;
  for (const offset of [0, 4, 8, 12]) {
    const bit = digest.readUInt32BE(offset) % bitCount;
    if ((filter[Math.floor(bit / 8)]! & (1 << (bit % 8))) === 0) {
      return false;
    }
  }
  return true;
}

function isSessionState(value: unknown): value is SessionState {
  return (
    isRecord(value) &&
    typeof value.streamIndex === "number" &&
    Number.isInteger(value.streamIndex) &&
    value.streamIndex >= 0 &&
    (value.continuationToken === undefined ||
      typeof value.continuationToken === "string") &&
    (value.sessionId === undefined || typeof value.sessionId === "string")
  );
}

function invalidStore(): Error {
  return new Error("FailureReport MCP operation store has an invalid format.");
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function rootRequestFingerprint(request: RootRequest): string {
  return createHash("sha256")
    .update(canonicalJson(request), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
