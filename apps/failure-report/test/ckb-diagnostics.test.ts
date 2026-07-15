import { describe, expect, it } from "vitest";

import { recommendCkbLog } from "../agent/subagents/ckb/diagnostics.js";

describe("CKB diagnostic recommendations", () => {
  it("keeps transaction-assembly logs structured and bounded", () => {
    const recommendation = recommendCkbLog(
      "transaction_assembly",
      "completeFeeBy",
      ["input_count", "change_output_count", "input_count"],
    );

    expect(recommendation.event).toBe("ckb.transaction.assembly");
    expect(recommendation.fields).toContain("input_count");
    expect(
      recommendation.fields.filter((field) => field === "input_count"),
    ).toHaveLength(1);
    expect(recommendation.guardrails.join(" ")).toContain("private keys");
  });
});
