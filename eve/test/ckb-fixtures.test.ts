import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** Immutable fixture URLs used by CKB sparse-evidence regression tests. */
const issue45 = new URL(
  "../evals/ckb/fixtures/issue-45/issue.json",
  import.meta.url,
);
const issue45Patch = new URL(
  "../evals/ckb/fixtures/issue-45/fix.patch",
  import.meta.url,
);

/** Ensures the intentionally incomplete #45 evidence stays incomplete in fixtures. */
describe("CKB fixtures", () => {
  it("preserves Issue #45 as evidence-sparse instead of inventing a diagnosis", async () => {
    const issue = JSON.parse(await readFile(issue45, "utf8")) as {
      number: number;
      comments: Array<{ body: string }>;
    };
    const patch = await readFile(issue45Patch, "utf8");

    expect(issue.number).toBe(45);
    expect(issue.comments[0]?.body).toContain(
      "086d144e4bccb10aeedb4c3719a9f9ecca4dc221",
    );
    expect(patch).toContain("consolidate transaction fee handling");
  });
});
