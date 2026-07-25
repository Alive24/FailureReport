import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { RootRequest, RootResult } from "@failure-report/protocol";

import {
  createMcpRootInvoker,
  EveChannelRootInvoker,
  InMemoryRootSessionStore,
  type EveChannelRootPendingTurnConsumer,
  type EveChannelRootTransport,
  type RootOperationStore,
} from "../src/index.js";

describe("durable Root operation lifecycle", () => {
  it("reattaches the same request after delivery and adapter restart without resending", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "failure-report-root-restart-"),
    );
    const storePath = join(temporaryRoot, "operations.json");
    const accepted = deferred<void>();
    const neverFinishes = deferred<never>();
    let sends = 0;
    const request = issueRequest("restart-original", 31);

    try {
      const first = createMcpRootInvoker({
        session_store_path: storePath,
        transport: {
          async run(input) {
            sends += 1;
            await input.onDelivered({
              continuationToken: "eve:restart:delivered",
              sessionId: "session-restart",
              streamIndex: 0,
            });
            accepted.resolve();
            return neverFinishes.promise;
          },
        },
      });
      const disconnectedCall = first.invoke(request);
      await accepted.promise;

      const persistedAfterDelivery = JSON.parse(
        await readFile(storePath, "utf8"),
      ) as {
        sessions: Record<
          string,
          { operations: Record<string, { state: string }> }
        >;
      };
      expect(
        persistedAfterDelivery.sessions["issue:Alive24/FailureReport#31"]
          ?.operations["restart-original"]?.state,
      ).toBe("delivered");

      const restarted = createMcpRootInvoker({
        session_store_path: storePath,
        transport: recoveryTransport({
          request_id: request.request_id,
          status: "completed",
          summary: "Recovered the original delivered Root result.",
        }),
      });
      const retried = await restarted.invoke(request);

      expect(retried.summary).toContain("original delivered");
      await expect(disconnectedCall).resolves.toEqual(retried);
      expect(sends).toBe(1);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("recovers a queued same-session request after restart and delivers it once in order", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "failure-report-root-queue-"),
    );
    const storePath = join(temporaryRoot, "operations.json");
    const firstAccepted = deferred<void>();
    const neverFinishes = deferred<never>();
    const deliveredIds: string[] = [];
    const firstRequest = issueRequest("queue-first", 31);
    const secondRequest = issueRequest("queue-second", 31);

    try {
      const firstProcess = createMcpRootInvoker({
        session_store_path: storePath,
        transport: {
          async run(input) {
            deliveredIds.push(requestIdFromMessage(input.message));
            await input.onDelivered({
              continuationToken: "eve:queue:first",
              sessionId: "session-queue",
              streamIndex: 0,
            });
            firstAccepted.resolve();
            return neverFinishes.promise;
          },
        },
      });
      const firstCall = firstProcess.invoke(firstRequest);
      await firstAccepted.promise;
      const queuedCall = firstProcess.invoke(secondRequest);
      await waitFor(async () => {
        const persisted = await readFile(storePath, "utf8");
        return persisted.includes('"queue-second"');
      });

      const restartedTransport = {
        async run(input) {
          const requestId = requestIdFromMessage(input.message);
          deliveredIds.push(requestId);
          expect(requestId).toBe("queue-second");
          expect(input.sessionState).toMatchObject({
            sessionId: "session-queue",
            streamIndex: 4,
          });
          await input.onDelivered({
            continuationToken: "eve:queue:second",
            sessionId: "session-queue",
            streamIndex: 4,
          });
          return terminalTurn(requestId, "Delivered the queued request.", 8);
        },
        async consumePendingTurn() {
          return terminalTurn("queue-first", "Recovered the first request.", 4);
        },
      } satisfies EveChannelRootTransport & EveChannelRootPendingTurnConsumer;
      const restarted = createMcpRootInvoker({
        session_store_path: storePath,
        transport: restartedTransport,
      });
      await restarted.resumePendingOperations();

      const [firstResult, secondResult] = await Promise.all([
        restarted.invoke(firstRequest),
        restarted.invoke(secondRequest),
      ]);
      await expect(firstCall).resolves.toEqual(firstResult);
      await expect(queuedCall).resolves.toEqual(secondResult);

      expect(deliveredIds).toEqual(["queue-first", "queue-second"]);
      expect(firstResult.summary).toContain("first request");
      expect(secondResult.summary).toContain("queued request");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("serializes one canonical session while unrelated session keys remain concurrent", async () => {
    const gates = new Map<string, Deferred<void>>();
    const deliveredIds: string[] = [];
    const transport: EveChannelRootTransport = {
      async run(input) {
        const requestId = requestIdFromMessage(input.message);
        deliveredIds.push(requestId);
        const gate = deferred<void>();
        gates.set(requestId, gate);
        await input.onDelivered({
          continuationToken: "eve:" + requestId,
          sessionId:
            input.sessionState?.sessionId ??
            "session:" + (requestId === "different-key" ? "32" : "31"),
          streamIndex: input.sessionState?.streamIndex ?? 0,
        });
        await gate.promise;
        return terminalTurn(
          requestId,
          "Completed " + requestId + ".",
          (input.sessionState?.streamIndex ?? 0) + 2,
          input.sessionState?.sessionId ??
            "session:" + (requestId === "different-key" ? "32" : "31"),
        );
      },
    };
    const invoker = new EveChannelRootInvoker(
      transport,
      new InMemoryRootSessionStore(),
    );

    const first = invoker.invoke(issueRequest("same-key-first", 31));
    const second = invoker.invoke(issueRequest("same-key-second", 31));
    const unrelated = invoker.invoke(issueRequest("different-key", 32));

    await waitFor(() => deliveredIds.length === 2);
    expect(deliveredIds).toEqual(
      expect.arrayContaining(["same-key-first", "different-key"]),
    );
    expect(deliveredIds).not.toContain("same-key-second");

    gates.get("different-key")?.resolve();
    gates.get("same-key-first")?.resolve();
    await waitFor(() => deliveredIds.includes("same-key-second"));
    gates.get("same-key-second")?.resolve();

    await expect(Promise.all([first, second, unrelated])).resolves.toHaveLength(
      3,
    );
    expect(deliveredIds.filter((id) => id === "same-key-second")).toHaveLength(
      1,
    );
  });

  it("binds one request_id to only one canonical session", async () => {
    const sends: string[] = [];
    const invoker = new EveChannelRootInvoker(
      {
        async run(input) {
          const requestId = requestIdFromMessage(input.message);
          sends.push(requestId);
          await input.onDelivered({
            sessionId: "session-request-owner",
            streamIndex: 0,
          });
          return terminalTurn(
            requestId,
            "Bound the request id.",
            2,
            "session-request-owner",
          );
        },
      },
      new InMemoryRootSessionStore(),
    );
    const original = issueRequest("globally-owned-request", 31);
    const changedSession = issueRequest("globally-owned-request", 32);

    expect((await invoker.invoke(original)).status).toBe("completed");
    const rejected = await invoker.invoke(changedSession);

    expect(rejected.status).toBe("failed");
    expect(rejected.summary).toContain("could not be validated or written");
    expect(sends).toEqual(["globally-owned-request"]);
  });

  it("fails closed on partially written ownership without delivering a message", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "failure-report-root-corrupt-"),
    );
    const storePath = join(temporaryRoot, "operations.json");
    const request = issueRequest("corrupt-owner", 31);
    let sends = 0;

    try {
      await mkdir(dirname(storePath), { recursive: true });
      await writeFile(
        storePath,
        JSON.stringify({
          version: 2,
          sessions: {
            "issue:Alive24/FailureReport#31": {
              active_request_id: request.request_id,
              queue: [],
              operations: {
                [request.request_id]: {
                  state: "delivered",
                  request_id: request.request_id,
                  request_fingerprint: "not-a-valid-fingerprint",
                  request,
                  delivery_owner: "lost-process",
                  delivered_at: new Date().toISOString(),
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              },
            },
          },
        }),
      );
      const invoker = createMcpRootInvoker({
        session_store_path: storePath,
        transport: {
          async run() {
            sends += 1;
            throw new Error("must not deliver");
          },
        },
      });

      await expect(invoker.resumePendingOperations()).resolves.toBeUndefined();
      const result = await invoker.invoke(request);

      expect(result).toMatchObject({
        request_id: request.request_id,
        status: "failed",
      });
      expect(result.summary).toContain("could not be validated");
      expect(sends).toBe(0);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("migrates a cursor-only version 1 store without losing Root continuity", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "failure-report-root-v1-"),
    );
    const storePath = join(temporaryRoot, "operations.json");
    const request = issueRequest("v1-migration", 31);
    let receivedCursor: unknown;

    try {
      await writeFile(
        storePath,
        JSON.stringify({
          version: 1,
          entries: {
            "issue:Alive24/FailureReport#31": {
              continuationToken: "eve:v1",
              sessionId: "session-v1",
              streamIndex: 7,
            },
          },
        }),
      );
      const invoker = createMcpRootInvoker({
        session_store_path: storePath,
        transport: {
          async run(input) {
            receivedCursor = input.sessionState;
            await input.onDelivered({
              continuationToken: "eve:v2:delivered",
              sessionId: "session-v1",
              streamIndex: 7,
            });
            return terminalTurn(
              request.request_id,
              "Migrated the cursor-only store.",
              9,
              "session-v1",
            );
          },
        },
      });

      const result = await invoker.invoke(request);
      const persisted = JSON.parse(await readFile(storePath, "utf8")) as {
        version: number;
      };

      expect(result.status).toBe("completed");
      expect(receivedCursor).toMatchObject({
        continuationToken: "eve:v1",
        sessionId: "session-v1",
        streamIndex: 7,
      });
      expect(persisted.version).toBe(2);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("blocks an ambiguous delivery attempt instead of resending it", async () => {
    let sends = 0;
    const request = issueRequest("ambiguous-delivery", 31);
    const invoker = new EveChannelRootInvoker(
      {
        async run() {
          sends += 1;
          // A lost POST response cannot prove whether Eve accepted the turn.
          throw new Error("connection lost during delivery");
        },
      },
      new InMemoryRootSessionStore(),
    );

    const first = await invoker.invoke(request);
    const retry = await invoker.invoke(request);
    const differentRequest = await invoker.invoke(
      issueRequest("ambiguous-follow-up", 31),
    );

    expect(first.summary).toContain("blocked");
    expect(retry.summary).toContain("blocked");
    expect(differentRequest.summary).toContain("blocked");
    expect(sends).toBe(1);
  });

  it("atomically commits the final cursor with the terminal result", async () => {
    const innerStore = new InMemoryRootSessionStore();
    const crashBeforeTerminalCommit = new DropFirstTerminalMutationStore(
      innerStore,
    );
    const request = issueRequest("terminal-atomicity", 31);
    let sends = 0;
    const firstProcess = new EveChannelRootInvoker(
      {
        async run(input) {
          sends += 1;
          await input.onDelivered({
            continuationToken: "eve:atomic:delivered",
            sessionId: "session-atomic",
            streamIndex: 0,
          });
          return terminalTurn(
            request.request_id,
            "Result interrupted before commit.",
            4,
            "session-atomic",
          );
        },
      },
      crashBeforeTerminalCommit,
    );

    const interrupted = await firstProcess.invoke(request);
    expect(interrupted.status).toBe("failed");
    expect(
      (await innerStore.readLedger("issue:Alive24/FailureReport#31"))
        ?.operations[request.request_id]?.state,
    ).toBe("delivered");

    const restarted = new EveChannelRootInvoker(
      recoveryTransport({
        request_id: request.request_id,
        status: "completed",
        summary: "Redrained after the atomic commit interruption.",
      }),
      crashBeforeTerminalCommit,
    );
    const recovered = await restarted.invoke(request);

    expect(recovered.summary).toContain("Redrained");
    expect(sends).toBe(1);
  });

  it("bounds terminal records while preserving delayed retries and later continuity", async () => {
    const sends: string[] = [];
    const store = new InMemoryRootSessionStore();
    const transport: EveChannelRootTransport = {
      async run(input) {
        const requestId = requestIdFromMessage(input.message);
        sends.push(requestId);
        await input.onDelivered({
          continuationToken: "eve:cleanup:" + requestId,
          sessionId: "session-cleanup",
          streamIndex: input.sessionState?.streamIndex ?? 0,
        });
        return terminalTurn(
          requestId,
          "Terminal result for " + requestId + ".",
          (input.sessionState?.streamIndex ?? 0) + 2,
          "session-cleanup",
        );
      },
    };
    const invoker = new EveChannelRootInvoker(transport, store, {
      retention: {
        terminal_operations: 1,
        cleaned_operations: 1,
      },
    });
    const requests = ["cleanup-one", "cleanup-two", "cleanup-three"].map((id) =>
      issueRequest(id, 31),
    );

    for (const request of requests) {
      await invoker.invoke(request);
    }
    const ledger = await store.readLedger("issue:Alive24/FailureReport#31");
    expect(
      Object.values(ledger?.operations ?? {}).filter(
        (operation) => operation.state === "terminal",
      ),
    ).toHaveLength(1);
    expect(
      Object.values(ledger?.operations ?? {}).filter(
        (operation) => operation.state === "cleaned",
      ),
    ).toHaveLength(1);
    expect(ledger?.retired_request_filter).toBeTruthy();

    const retainedRetry = await invoker.invoke(requests[1]!);
    const retiredRetry = await invoker.invoke(requests[0]!);
    const later = await invoker.invoke(issueRequest("cleanup-four", 31));

    expect(retainedRetry.summary).toContain("cleanup-two");
    expect(retiredRetry).toMatchObject({ status: "failed" });
    expect(retiredRetry.summary).toContain("will not be delivered again");
    expect(later.status).toBe("completed");
    expect(sends).toEqual([
      "cleanup-one",
      "cleanup-two",
      "cleanup-three",
      "cleanup-four",
    ]);
  });
});

function issueRequest(requestId: string, issueNumber: number): RootRequest {
  return {
    request_id: requestId,
    operation: "inspect",
    issue: {
      provider: "github_issue",
      repository: "Alive24/FailureReport",
      issue_number: issueNumber,
      issue_url:
        "https://github.com/Alive24/FailureReport/issues/" +
        String(issueNumber),
      workpad_marker: "<!-- failure-report-workpad -->",
      workpad_revision: 1,
    },
    message: "Inspect the durable report.",
  };
}

function recoveryTransport(
  result: RootResult,
): EveChannelRootTransport & EveChannelRootPendingTurnConsumer {
  return {
    async run() {
      throw new Error("A delivered request must not be sent again.");
    },
    async consumePendingTurn() {
      return {
        data: result,
        status: "completed",
        sessionState: {
          continuationToken: "eve:restart:terminal",
          sessionId: "session-restart",
          streamIndex: 4,
        },
      };
    },
  };
}

function terminalTurn(
  requestId: string,
  summary: string,
  streamIndex: number,
  sessionId = "session-queue",
) {
  return {
    data: {
      request_id: requestId,
      status: "completed" as const,
      summary,
    },
    status: "completed" as const,
    sessionState: {
      continuationToken: "eve:terminal:" + requestId,
      sessionId,
      streamIndex,
    },
  };
}

function requestIdFromMessage(message: string): string {
  const match = message.match(
    /ROOT_REQUEST_DATA\n([\s\S]+)\nEND_ROOT_REQUEST_DATA/,
  );
  if (!match?.[1]) {
    throw new Error("Root request envelope was not found.");
  }
  return (JSON.parse(match[1]) as { request_id: string }).request_id;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class DropFirstTerminalMutationStore implements RootOperationStore {
  readonly runtime_id: string;
  private dropTerminalMutation = true;

  constructor(private readonly inner: RootOperationStore) {
    this.runtime_id = inner.runtime_id;
  }

  readLedger(key: string) {
    return this.inner.readLedger(key);
  }

  listSessionKeys() {
    return this.inner.listSessionKeys();
  }

  mutateLedger<T>(
    key: string,
    mutation: Parameters<RootOperationStore["mutateLedger"]>[1],
  ): Promise<T> {
    return this.inner.mutateLedger(key, (ledger) => {
      const result = mutation(ledger);
      if (
        this.dropTerminalMutation &&
        Object.values(result.ledger.operations).some(
          (operation) => operation.state === "terminal",
        )
      ) {
        this.dropTerminalMutation = false;
        throw new Error("simulated crash before terminal mutation commit");
      }
      return result;
    }) as Promise<T>;
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
