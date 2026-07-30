import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cliArguments = process.argv.slice(2);
if (cliArguments[0] === "--") {
  cliArguments.shift();
}
const [repository = "Alive24/CKBoost", rawIssueNumber = "56"] = cliArguments;
const issueNumber = Number(rawIssueNumber);

if (
  !/^[^/\s]+\/[^/\s]+$/.test(repository) ||
  !Number.isSafeInteger(issueNumber) ||
  issueNumber <= 0
) {
  console.error(
    "Usage: pnpm --filter @failure-report/mcp-adapter demo:existing-issue -- <owner/repository> <issue-number>",
  );
  process.exit(2);
}

const repositoryRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const transport = new StdioClientTransport({
  command: "pnpm",
  args: ["--filter", "@failure-report/mcp-adapter", "mcp"],
  cwd: repositoryRoot,
  env: process.env,
});
const client = new Client({
  name: "failure-report-opensourceirl-demo",
  version: "0.1.0",
});

await client.connect(transport);
try {
  const response = await client.callTool(
    {
      name: "failure_report",
      arguments: {
        request_id: `demo-inspect-${issueNumber}-${Date.now()}`,
        operation: "inspect",
        issue_selector: {
          repository,
          issue_number: issueNumber,
        },
        message:
          "Read the latest durable FailureReport workpad and return a concise current-state inspection. Do not mutate shared context, invoke a worker, change branches, render, deliver, or change tracker state.",
      },
    },
    undefined,
    { timeout: 900_000 },
  );
  if (response.isError) {
    throw new Error(
      response.content
        .map((item) => ("text" in item ? item.text : ""))
        .filter(Boolean)
        .join("\n") || "FailureReport MCP returned an error.",
    );
  }

  const result = response.structuredContent;
  const report = result?.report;
  const issue = result?.issue ?? report?.shared_context;
  const snapshot = report?.diagnostic_session?.diagnostic_branch;
  console.log(
    JSON.stringify(
      {
        request_id: result?.request_id,
        status: result?.status,
        summary: result?.summary,
        issue: issue
          ? {
              url: issue.issue_url,
              workpad_revision: issue.workpad_revision,
              workpad_comment_ref: issue.workpad_comment_ref,
            }
          : undefined,
        report: report
          ? {
              id: report.id,
              status: report.status,
              confidence: report.conclusion?.confidence.level,
              diagnostic_session: report.diagnostic_session?.lifecycle,
              diagnostic_snapshot: snapshot
                ? {
                    branch: snapshot.name,
                    url: snapshot.remote_url,
                  }
                : undefined,
              handoff: {
                todo_status: report.handoff.todo_status,
                gate_decision: report.handoff.gate_decision,
              },
            }
          : undefined,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
