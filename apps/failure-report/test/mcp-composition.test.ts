import { describe, expect, it } from "vitest";

import { createMcpRootInvoker, type EveRootTransport } from "../src/index.js";

describe("MCP Root composition", () => {
  it("composes the public MCP path through Eve Root rather than a domain backend", async () => {
    const seen: string[] = [];
    const transport: EveRootTransport = {
      async run(input) {
        seen.push(input.message);
        return {
          data: {
            request_id: "mcp-root-composition",
            status: "completed",
            summary: "Eve Root handled the MCP request.",
          },
          status: "completed",
          sessionState: { streamIndex: 1 },
        };
      },
    };

    const result = await createMcpRootInvoker({ transport }).invoke({
      request_id: "mcp-root-composition",
      operation: "inspect",
      message: "Inspect the durable report.",
    });

    expect(result.status).toBe("completed");
    expect(seen[0]).toContain("ROOT_REQUEST_DATA");
  });
});
