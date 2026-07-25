import { describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => {
  let resolveResult!: (value: { data: unknown; status: "completed" }) => void;
  const result = new Promise<{
    data: unknown;
    status: "completed";
  }>((resolve) => {
    resolveResult = resolve;
  });
  return {
    result,
    resolveResult,
    initialState: undefined as unknown,
  };
});

vi.mock("eve/client", () => ({
  Client: class {
    session(initialState: unknown) {
      lifecycle.initialState = initialState;
      return {
        state: {
          continuationToken: "eve:terminal",
          sessionId: "session-existing",
          streamIndex: 8,
        },
        async send() {
          return {
            continuationToken: "eve:delivered",
            sessionId: "session-existing",
            result: () => lifecycle.result,
          };
        },
      };
    }
  },
}));

import { EveChannelRootTransport } from "../src/index.js";

describe("Eve Channel Root transport delivery boundary", () => {
  it("publishes the allocated cursor before waiting for the terminal result", async () => {
    const transport = new EveChannelRootTransport({
      host: "https://eve.example.test",
    });
    const deliveredStates: unknown[] = [];
    let settled = false;

    const running = transport
      .run({
        message: "Root request",
        sessionState: {
          continuationToken: "eve:prior",
          sessionId: "session-existing",
          streamIndex: 4,
        },
        async onDelivered(sessionState) {
          deliveredStates.push(sessionState);
        },
      })
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => {
      expect(deliveredStates).toHaveLength(1);
    });
    expect(settled).toBe(false);
    expect(lifecycle.initialState).toMatchObject({
      continuationToken: "eve:prior",
      streamIndex: 4,
    });
    expect(deliveredStates[0]).toEqual({
      continuationToken: "eve:delivered",
      sessionId: "session-existing",
      streamIndex: 4,
    });

    lifecycle.resolveResult({
      data: {
        request_id: "transport-result",
        status: "completed",
        summary: "Completed.",
      },
      status: "completed",
    });
    await expect(running).resolves.toMatchObject({
      sessionState: {
        continuationToken: "eve:terminal",
        streamIndex: 8,
      },
    });
  });
});
