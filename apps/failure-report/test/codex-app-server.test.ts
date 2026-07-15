import { describe, expect, it } from "vitest";

import {
  JsonRpcRequestError,
  JsonRpcSession,
} from "../src/codex-app-server.js";

describe("Codex App-server JSON-RPC session", () => {
  it("matches a request response by id", async () => {
    const sent: unknown[] = [];
    const session = new JsonRpcSession((message) => sent.push(message), 1000);
    const response = session.request<{ thread: { id: string } }>(
      "thread/start",
      {
        model: "gpt-5.4",
      },
    );

    expect(sent).toEqual([
      {
        id: 1,
        method: "thread/start",
        params: { model: "gpt-5.4" },
      },
    ]);
    session.receive({ id: 1, result: { thread: { id: "thr_123" } } });

    await expect(response).resolves.toEqual({ thread: { id: "thr_123" } });
  });

  it("surfaces structured JSON-RPC errors", async () => {
    const session = new JsonRpcSession(() => undefined, 1000);
    const response = session.request("thread/start");
    session.receive({
      id: 1,
      error: { code: -32000, message: "Not initialized" },
    });

    await expect(response).rejects.toEqual(
      new JsonRpcRequestError(-32000, "Not initialized"),
    );
  });

  it("forwards notifications without confusing them for responses", () => {
    const received: string[] = [];
    const session = new JsonRpcSession(() => undefined, 1000);
    session.onNotification((notification) =>
      received.push(notification.method),
    );

    session.receive({
      method: "turn/completed",
      params: { turn: { id: "t1" } },
    });

    expect(received).toEqual(["turn/completed"]);
  });
});
