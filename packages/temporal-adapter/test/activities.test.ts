import { describe, expect, it, vi } from "vitest";

import type { RootInvoker } from "@failure-report/protocol";

import { createFailureReportActivities } from "../src/activities.js";

/** Ensures Temporal activities delegate external work only through the Root port. */
describe("Temporal Root Activity", () => {
  it("delegates external work to RootInvoker", async () => {
    const invoke = vi.fn().mockResolvedValue({
      request_id: "temporal-start-1",
      status: "accepted",
      summary: "Root accepted the report.",
    });
    const activities = createFailureReportActivities({
      invoke,
    } satisfies RootInvoker);

    const result = await activities.invokeRoot({
      request_id: "temporal-start-1",
      operation: "start",
      message: "Begin an evidence-backed investigation.",
    });

    expect(result.status).toBe("accepted");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("round-trips a structured human-input request without adding workflow semantics", async () => {
    const humanInputRequest = {
      schema_version: "failure-report/human-input-request/v1" as const,
      request_id: "failure-report/human-input-request/sha256/" + "b".repeat(64),
      report: {
        report_id: "report-27",
        issue: {
          repository: "Alive24/FailureReport",
          issue_number: 27,
          issue_url: "https://github.com/Alive24/FailureReport/issues/27",
        },
        workpad: {
          revision: 8,
          logical_session_id: "github-issue/Alive24/FailureReport/27/report-27",
          entry_id:
            "github-issue/Alive24/FailureReport/27/report-27/revision-8",
        },
      },
      target: {
        repository: "Alive24/FailureReport",
        revision: "7".repeat(40),
      },
      diagnostic_session: {
        identity: "diagnostic-session/27",
        lifecycle: "active" as const,
      },
      confirmed_facts: [
        {
          evidence_id: "evidence/27",
          fact: "The current output is unversioned.",
        },
      ],
      completed_or_exhausted_experiments: [
        {
          experiment_id: "experiment/27",
          question: "Can the decision be derived from code?",
          outcome: "inconclusive" as const,
          interpretation: "The repository does not encode the product choice.",
        },
      ],
      eliminated_hypotheses: [
        {
          hypothesis_id: "hypothesis/27",
          statement: "The adapter owns promotion policy.",
        },
      ],
      remaining_material_unknown: "The required product policy is unknown.",
      viable_options: ["Choose policy A.", "Choose policy B."],
      question: "Which policy should govern the implementation?",
      resume_condition: "Resume the same session after one policy is selected.",
      markdown: "# Need Human Input\n",
    };
    const invoke = vi.fn().mockResolvedValue({
      request_id: "temporal-human-input-27",
      status: "needs_input",
      summary: "One material decision remains.",
      human_input_request: humanInputRequest,
    });
    const activities = createFailureReportActivities({
      invoke,
    } satisfies RootInvoker);

    const result = await activities.invokeRoot({
      request_id: "temporal-human-input-27",
      operation: "inspect",
      message: "Adapter round-trip fixture.",
    });

    expect(result.human_input_request).toEqual(humanInputRequest);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects the retired approval-continuation request before invoking Root", async () => {
    const invoke = vi.fn();
    const activities = createFailureReportActivities({ invoke } as RootInvoker);

    await expect(
      activities.invokeRoot({
        request_id: "temporal-approval-1",
        operation: "submit_action_result",
        action_result: { approved: true },
      } as never),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
