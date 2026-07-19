import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import type { RootInvoker } from "@failure-report/protocol";

import { createFailureReportMcpServer } from "../src/index.js";

/**
 * Offline local MCP smoke harness for the first existing-Issue request shape.
 *
 * It links a real MCP client/server pair but uses a read-only fake Root, so it
 * proves the public selector path without requiring GitHub credentials or
 * mutating an Issue/workpad during ordinary test runs.
 */
describe("existing-Issue MCP intake smoke", () => {
  it("accepts only repository and Issue number, then returns Root's canonical context", async () => {
    const seen: unknown[] = [];
    const canonicalIssue = {
      provider: "github_issue" as const,
      repository: "Alive24/CKBoost",
      issue_number: 56,
      issue_url: "https://github.com/Alive24/CKBoost/issues/56",
      workpad_marker: "<!-- failure-report-workpad -->" as const,
      workpad_revision: 0,
    };
    const invoker: RootInvoker = {
      async invoke(request) {
        seen.push(request);
        return {
          request_id: request.request_id,
          status: "completed",
          issue: canonicalIssue,
          summary: "Read the existing Issue without publishing a workpad.",
        };
      },
    };
    const server = createFailureReportMcpServer(invoker);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "failure-report-existing-issue-smoke",
      version: "0.1.0",
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({
        name: "failure_report",
        arguments: {
          request_id: "mcp-existing-issue-smoke",
          operation: "start",
          issue_selector: {
            repository: "Alive24/CKBoost",
            issue_number: 56,
          },
          message: "Start from the existing GitHub Issue.",
        },
      });

      expect(response.isError).not.toBe(true);
      expect(seen).toEqual([
        expect.objectContaining({
          issue_selector: {
            repository: "Alive24/CKBoost",
            issue_number: 56,
          },
        }),
      ]);
      expect(response.structuredContent).toMatchObject({
        request_id: "mcp-existing-issue-smoke",
        status: "completed",
        issue: canonicalIssue,
      });
    } finally {
      await client.close();
    }
  });
});
