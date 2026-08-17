import { describe, expect, it } from "vitest";

import { runtimeBindingResponse } from "../agent/channels/runtime-binding.js";

describe("runtime binding channel", () => {
  it("returns only repository identity and an opaque runtime instance", async () => {
    const response = runtimeBindingResponse({
      FAILURE_REPORT_TARGET_REPOSITORY: "Alive24/FailureReport",
      FAILURE_REPORT_RUNTIME_INSTANCE_ID: "instance-69",
      FAILURE_REPORT_TARGET_WORKSPACE: "/private/checkout",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      schema_version: "failure-report/runtime-binding/v1",
      status: "ready",
      repository: "Alive24/FailureReport",
      instance_id: "instance-69",
    });
    expect(JSON.stringify(body)).not.toContain("/private/checkout");
  });

  it("fails readiness closed when the verified binding is absent", async () => {
    const response = runtimeBindingResponse({
      FAILURE_REPORT_TARGET_WORKSPACE: "/private/checkout",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      schema_version: "failure-report/runtime-binding/v1",
      status: "not_ready",
    });
  });
});
