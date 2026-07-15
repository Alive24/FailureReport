import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { failureReportSchema } from "@failure-report/protocol";

import policyJson from "../config/backend/policy.json" with { type: "json" };

import { parseBackendPolicy } from "../../src/backend-policy.js";
import { CodexAppServerClient } from "../../src/codex-app-server.js";

const policy = parseBackendPolicy(policyJson);

export default defineTool({
  description:
    "Run a bounded, approval-gated deep investigation through local Codex App-server.",
  inputSchema: z
    .object({
      report: failureReportSchema,
      workspace: z.string().min(1),
      request: z.string().min(1),
      thread_id: z.string().min(1).optional(),
    })
    .strict(),
  approval: always(),
  async execute(input) {
    const client = new CodexAppServerClient({
      command: policy.investigator.command,
      arguments: policy.investigator.arguments,
      model: policy.investigator.model,
      timeout_ms: policy.investigator.timeout_ms,
      approval_policy: policy.investigator.approval_policy,
    });
    try {
      return await client.runInvestigation(input);
    } finally {
      client.close();
    }
  },
});
