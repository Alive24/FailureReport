import { describe, expect, it, vi } from "vitest";

import type { RootInvoker } from "@failure-report/runtime-port";

import { createFailureReportActivities } from "../src/activities.js";

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
});
