import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createCodexAppServerPreflight } from "../agent/lib/backends/codex-app-server-preflight.js";

const runSmoke = process.env.FAILURE_REPORT_RUN_CODEX_APP_SERVER_SMOKE === "1";
const smokeDescribe = runSmoke ? describe : describe.skip;
const skillName = "failure-report-ckb-debugging";

/**
 * Opt-in integration smoke. It uses the caller's ambient Codex runtime and
 * performs only the bounded initialize plus `skills/list` preflight exchange.
 */
smokeDescribe("Codex native skill discovery", () => {
  it("discovers the Root-style .agents/skills symlink in a temporary Git worktree", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "failure-report-codex-native-skill-"),
    );
    const worktree = join(temporaryRoot, "diagnostic-worktree");
    const source = fileURLToPath(
      new URL(
        "../../packages/ckb-domain-pack/extension/skills/failure-report-ckb-debugging/",
        import.meta.url,
      ),
    );

    try {
      await mkdir(join(worktree, ".agents", "skills"), { recursive: true });
      await runCommand("git", ["init", "-q", worktree]);
      await symlink(
        source,
        join(worktree, ".agents", "skills", skillName),
        "dir",
      );

      const preflight = createCodexAppServerPreflight();
      const readiness = await preflight({
        executable: "codex",
        workspace: {
          path: worktree,
          native_skill_names: [skillName],
        },
      });
      expect(readiness.status, JSON.stringify(readiness)).toBe("ready");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30000);
});

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(command + " exited with " + String(code)));
      }
    });
  });
}
