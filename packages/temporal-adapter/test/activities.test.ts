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
