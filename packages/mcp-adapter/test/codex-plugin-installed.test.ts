import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const sourcePluginRoot = fileURLToPath(
  new URL("../../codex-plugin/failure-report/", import.meta.url),
);

type PluginMcpServer = {
  command: string;
  args: string[];
  cwd: string;
};

describe("clean-installed Codex plugin MCP", () => {
  it("initializes, lists failure_report, and accepts Issue-only intake", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "failure-report-plugin-install-"),
    );
    const installedPluginRoot = join(
      temporaryRoot,
      "cache",
      "failure-report",
      "0.2.0+test",
    );
    await cp(sourcePluginRoot, installedPluginRoot, { recursive: true });

    const config = JSON.parse(
      await readFile(join(installedPluginRoot, ".mcp.json"), "utf8"),
    ) as Record<string, PluginMcpServer>;
    const server = config["failure-report"];
    expect(server).toBeDefined();

    const transport = new StdioClientTransport({
      command: server!.command,
      args: server!.args,
      cwd: resolve(installedPluginRoot, server!.cwd),
      env: {
        ...getDefaultEnvironment(),
        FAILURE_REPORT_RUNTIME_MODE: "remote",
        FAILURE_REPORT_EVE_HOST: "http://127.0.0.1:1",
        FAILURE_REPORT_REMOTE_REPOSITORY: "Alive24/FailureReport",
        FAILURE_REPORT_MCP_SESSION_STORE: join(
          temporaryRoot,
          "state",
          "sessions.json",
        ),
        FAILURE_REPORT_RUNTIME_STATE_ROOT: join(
          temporaryRoot,
          "state",
          "runtime",
        ),
      },
      stderr: "pipe",
    });
    const client = new Client({
      name: "failure-report-clean-install-test",
      version: "0.1.0",
    });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({
        name: "failure-report",
        version: "0.1.0",
      });

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["failure_report"]);

      const response = await client.callTool({
        name: "failure_report",
        arguments: {
          request_id: "clean-installed-issue-intake",
          operation: "start",
          issue_selector: {
            repository: "Alive24/FailureReport",
            issue_number: 67,
          },
          message: "Start from this existing GitHub Issue.",
        },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        request_id: "clean-installed-issue-intake",
        status: "failed",
      });
      expect(response.structuredContent).toEqual(
        expect.objectContaining({
          summary: expect.stringContaining("remote_unavailable"),
        }),
      );
    } finally {
      await client.close().catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
