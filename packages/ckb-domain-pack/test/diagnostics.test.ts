import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { recommendCkbLog } from "../extension/lib/diagnostics.js";

/** Verifies CKB log guidance stays useful without widening the sensitive payload. */
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

  it("keeps the extension a pure domain capability package", async () => {
    const extension = new URL("../extension/", import.meta.url);
    const [declaration, tools, skill] = await Promise.all([
      readFile(new URL("extension.ts", extension), "utf8"),
      readdir(new URL("tools/", extension)),
      readFile(
        new URL("skills/failure-report-ckb-debugging/SKILL.md", extension),
        "utf8",
      ),
    ]);

    expect(declaration).not.toContain("prepareExecution");
    expect(tools).toEqual(["recommend_log.ts"]);
    expect(skill).toContain("name: failure-report-ckb-debugging");
  });
});
