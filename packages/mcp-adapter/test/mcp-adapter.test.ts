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

  it("round-trips the versioned implementation handoff without interpreting it", async () => {
    const implementationHandoff = {
      schema_version: "failure-report/implementation-handoff/v1" as const,
      handoff_id:
        "failure-report/implementation-handoff/sha256/" + "a".repeat(64),
      report: {
        report_id: "report-27",
        issue: {
          repository: "Alive24/FailureReport",
          issue_number: 27,
          issue_url: "https://github.com/Alive24/FailureReport/issues/27",
        },
        workpad: {
          revision: 7,
          logical_session_id: "github-issue/Alive24/FailureReport/27/report-27",
          entry_id:
            "github-issue/Alive24/FailureReport/27/report-27/revision-7",
        },
      },
      target: {
        repository: "Alive24/FailureReport",
        revision: "7".repeat(40),
      },
      diagnostic_snapshot: {
        branch: "diagnostic/27-deterministic-handoff",
        remote_ref: "refs/heads/diagnostic/27-deterministic-handoff",
        remote_url:
          "https://github.com/Alive24/FailureReport/tree/diagnostic/27-deterministic-handoff",
        head_revision: "7".repeat(40),
        reuse_policy: "diagnostic_snapshot_only" as const,
      },
      diagnostic_completion_ids: ["diagnostic-completion/27"],
      evidence_refs: ["evidence/27"],
      contract: {
        goal: "Render a deterministic handoff.",
        why_now: "Downstream implementation needs an immutable contract.",
        scope_in: ["Root handoff rendering."],
        scope_out: ["Tracker promotion."],
        guardrails: ["Remain consumer-neutral."],
        required_outcomes: ["Equivalent input is byte-identical."],
        verification: {
          automated: ["Run adapter tests."],
          uat: ["Render twice."],
          context: ["Confirm no mutation."],
        },
        uat_required: true,
        residual_risks: [],
      },
      markdown: "# Implementation Handoff\n",
    };
    const invoke = vi.fn().mockResolvedValue({
      request_id: "mcp-render-27",
      status: "completed",
      summary: "Rendered the latest handoff.",
      implementation_handoff: implementationHandoff,
    });
    const handle = createRootRequestHandler({ invoke } satisfies RootInvoker);

    const result = await handle({
      request_id: "mcp-render-27",
      operation: "inspect",
      message: "Adapter round-trip fixture.",
    });

    expect(result.implementation_handoff).toEqual(implementationHandoff);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects the retired approval-continuation request before invoking Root", async () => {
    const invoke = vi.fn();
    const handle = createRootRequestHandler({ invoke } as RootInvoker);

    await expect(
      handle({
        request_id: "mcp-approval-1",
        operation: "submit_action_result",
        action_result: { approved: true },
      } as never),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
