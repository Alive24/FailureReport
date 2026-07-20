import { beforeEach, describe, expect, it, vi } from "vitest";

type CapturedClientOptions = {
  host: string;
  auth?: { bearer: string };
  redirect: "manual";
  preserveCompletedSessions: true;
};

const capturedClientOptions = vi.hoisted(() => [] as CapturedClientOptions[]);

vi.mock("eve/client", () => ({
  Client: class {
    constructor(options: CapturedClientOptions) {
      capturedClientOptions.push(options);
    }
  },
}));

import {
  createMcpRootInvoker,
  InMemoryRootSessionStore,
} from "../src/index.js";

/** Verifies the wrapper's local endpoint and explicit runtime connection options. */
describe("MCP Eve Channel connection", () => {
  beforeEach(() => {
    capturedClientOptions.length = 0;
  });

  it("uses the documented local eve dev endpoint with no environment options", () => {
    createMcpRootInvoker({ session_store: new InMemoryRootSessionStore() });

    expect(capturedClientOptions).toEqual([
      {
        host: "http://127.0.0.1:2000",
        redirect: "manual",
        preserveCompletedSessions: true,
      },
    ]);
  });

  it("uses an explicit host without adding optional bearer authentication", () => {
    createMcpRootInvoker({
      host: "https://eve.example.test",
      session_store: new InMemoryRootSessionStore(),
    });

    expect(capturedClientOptions).toEqual([
      {
        host: "https://eve.example.test",
        redirect: "manual",
        preserveCompletedSessions: true,
      },
    ]);
  });

  it("preserves an explicit bearer token for an overridden host", () => {
    createMcpRootInvoker({
      host: "https://eve.example.test",
      bearer: "runtime-token",
      session_store: new InMemoryRootSessionStore(),
    });

    expect(capturedClientOptions).toEqual([
      {
        host: "https://eve.example.test",
        auth: { bearer: "runtime-token" },
        redirect: "manual",
        preserveCompletedSessions: true,
      },
    ]);
  });
});
