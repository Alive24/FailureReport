import { describe, expect, it, vi } from "vitest";

import { resolveTargetRevision } from "../scripts/runtime-launcher.mjs";

describe("runtime launcher target revision", () => {
  it("resolves the trusted checkout HEAD to one immutable commit", async () => {
    const runGit = vi.fn().mockResolvedValue({
      stdout: "A".repeat(40) + "\n",
    });

    await expect(
      resolveTargetRevision("/private/trusted", runGit),
    ).resolves.toBe("a".repeat(40));
    expect(runGit).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: "/private/trusted" },
    );
  });

  it("rejects a symbolic selector or abbreviated revision", async () => {
    const runGit = vi.fn().mockResolvedValue({ stdout: "HEAD\n" });

    await expect(
      resolveTargetRevision("/private/trusted", runGit),
    ).rejects.toThrow("full immutable Git SHA");
  });
});
