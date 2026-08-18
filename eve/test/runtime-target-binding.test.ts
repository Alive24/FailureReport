import { describe, expect, it } from "vitest";

import {
  RuntimeTargetBindingError,
  readRuntimeTargetBinding,
} from "../agent/lib/runtime-target-binding.js";

describe("private runtime target binding", () => {
  it("returns a normalized repository and immutable revision", () => {
    expect(
      readRuntimeTargetBinding(
        {
          FAILURE_REPORT_TARGET_REPOSITORY: "Alive24/FailureReport",
          FAILURE_REPORT_TARGET_REVISION: "A".repeat(40),
        },
        "Alive24/FailureReport",
      ),
    ).toEqual({
      repository: "Alive24/FailureReport",
      revision: "a".repeat(40),
    });
  });

  it.each([
    {},
    {
      FAILURE_REPORT_TARGET_REPOSITORY: "Alive24/FailureReport",
      FAILURE_REPORT_TARGET_REVISION: "HEAD",
    },
    {
      FAILURE_REPORT_TARGET_REPOSITORY: "invalid",
      FAILURE_REPORT_TARGET_REVISION: "a".repeat(40),
    },
  ])("rejects an absent or invalid private binding", (environment) => {
    expect(() => readRuntimeTargetBinding(environment)).toThrow(
      RuntimeTargetBindingError,
    );
  });

  it("rejects an Issue repository that does not match the private binding", () => {
    expect(() =>
      readRuntimeTargetBinding(
        {
          FAILURE_REPORT_TARGET_REPOSITORY: "Alive24/FailureReport",
          FAILURE_REPORT_TARGET_REVISION: "a".repeat(40),
        },
        "Alive24/Other",
      ),
    ).toThrow("does not match");
  });
});
