import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  CodexAppServerTransportError,
  NodeCodexAppServerProcess,
} from "../agent/lib/backends/codex-app-server-transport.js";

/** JSONL fixtures for the shared persistent host-process transport. */
describe("Codex App Server JSONL transport", () => {
  it("routes requests, notifications, server requests, and live replies", async () => {
    const child = new FakeChildProcess();
    const process = new NodeCodexAppServerProcess(child.asChildProcess());
    const notifications: unknown[] = [];
    const serverRequests: unknown[] = [];
    process.onNotification((notification) => {
      notifications.push(notification);
    });
    process.onServerRequest((request) => {
      serverRequests.push(request);
    });

    const initialized = process.request("initialize", { clientInfo: "test" });
    expect(child.outbound).toEqual([
      { id: 1, method: "initialize", params: { clientInfo: "test" } },
    ]);
    child.serverSends({ id: 1, result: { protocolVersion: "v2" } });
    await expect(initialized).resolves.toEqual({ protocolVersion: "v2" });

    child.serverSends({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", delta: "hello" },
    });
    child.serverSends({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
    });

    expect(notifications).toEqual([
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", delta: "hello" },
      },
    ]);
    expect(serverRequests).toEqual([
      {
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
        },
      },
    ]);

    process.respond("approval-1", { decision: "decline" });
    expect(child.outbound.at(-1)).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
    await process.dispose();
  });

  it("rejects live requests and invokes close handlers after process loss", async () => {
    const child = new FakeChildProcess();
    const process = new NodeCodexAppServerProcess(child.asChildProcess());
    let closeError: Error | undefined;
    process.onClose((error) => {
      closeError = error;
    });

    const pending = process.request("thread/start", {});
    child.close();

    await expect(pending).rejects.toBeInstanceOf(CodexAppServerTransportError);
    expect(closeError).toBeInstanceOf(CodexAppServerTransportError);
    expect(() => process.notify("initialized", {})).toThrow(
      CodexAppServerTransportError,
    );
  });
});

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly outbound: unknown[] = [];
  exitCode: number | null = null;
  private stdinBuffer = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinBuffer += chunk.toString("utf8");
      const lines = this.stdinBuffer.split("\n");
      this.stdinBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line) {
          this.outbound.push(JSON.parse(line));
        }
      }
    });
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  serverSends(message: unknown): void {
    this.stdout.write(JSON.stringify(message) + "\n");
  }

  close(): void {
    this.exitCode = 1;
    this.emit("close", 1, null);
  }

  kill(): boolean {
    if (this.exitCode !== null) {
      return false;
    }
    this.exitCode = 0;
    this.emit("close", 0, null);
    return true;
  }
}
