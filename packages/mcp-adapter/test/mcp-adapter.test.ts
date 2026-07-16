import { describe, expect, it, vi } from "vitest";

import type { RootInvoker } from "@failure-report/protocol";

import { createRootRequestHandler } from "../src/index.js";

/** Verifies the adapter validates the public contract before it invokes Root. */
describe("MCP Root adapter", () => {
  it("validates then forwards only a Root request", async () => {
    const invoke = vi.fn().mockResolvedValue({
      request_id: "mcp-inspect-1",
      status: "completed",
      summary: "Root inspected the report.",
    });
    const invoker: RootInvoker = { invoke };
    const handle = createRootRequestHandler(invoker);

    const result = await handle({
      request_id: "mcp-inspect-1",
      operation: "inspect",
      message: "Inspect the current shared context.",
    });

    expect(result.status).toBe("completed");
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "inspect" }),
    );
  });
});
