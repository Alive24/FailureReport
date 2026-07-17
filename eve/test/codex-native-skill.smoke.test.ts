import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runSmoke = process.env.FAILURE_REPORT_RUN_CODEX_APP_SERVER_SMOKE === "1";
const smokeDescribe = runSmoke ? describe : describe.skip;
const skillName = "failure-report-ckb-debugging";

/**
 * Opt-in integration smoke test. It does not start a model turn: it asks the
 * local App Server's `skills/list` API to discover a worktree-local symlink.
 */
smokeDescribe("Codex native skill discovery", () => {
  it("discovers the Root-style .agents/skills symlink in a temporary Git worktree", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "failure-report-codex-native-skill-"),
    );
    const worktree = join(temporaryRoot, "diagnostic-worktree");
    const codexHome = join(temporaryRoot, "codex-home");
    const source = fileURLToPath(
      new URL(
        "../../packages/ckb-domain-pack/extension/skills/failure-report-ckb-debugging/",
        import.meta.url,
      ),
    );

    try {
      await mkdir(join(worktree, ".agents", "skills"), { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await runCommand("git", ["init", "-q", worktree]);
      await symlink(
        source,
        join(worktree, ".agents", "skills", skillName),
        "dir",
      );

      const appServer = startAppServer(worktree, codexHome);
      try {
        await appServer.request(1, "initialize", {
          clientInfo: {
            name: "failure-report-native-skill-smoke",
            title: "FailureReport native skill smoke",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        });
        appServer.notify("initialized", {});
        const response = await appServer.request(2, "skills/list", {
          cwds: [worktree],
          forceReload: true,
        });
        const data = responseData(response);
        const entry = data.find((candidate) => candidate.cwd === worktree);

        expect(entry?.errors).toEqual([]);
        expect(entry?.skills).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: skillName, scope: "repo" }),
          ]),
        );
      } finally {
        await appServer.stop();
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30000);
});

type SkillsListEntry = {
  cwd: string;
  errors: unknown[];
  skills: Array<{ name: string; scope: string }>;
};

type AppServerClient = {
  request(id: number, method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  stop(): Promise<void>;
};

function startAppServer(cwd: string, codexHome: string): AppServerClient {
  const child = spawn("codex", ["app-server"], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: Error): void }
  >();
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message) || typeof message.id !== "number") {
        continue;
      }
      const request = pending.get(message.id);
      if (!request) {
        continue;
      }
      pending.delete(message.id);
      if ("error" in message) {
        request.reject(
          new Error(
            "Codex App Server request failed: " + JSON.stringify(message.error),
          ),
        );
      } else {
        request.resolve(message.result);
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.once("error", (error) => {
    failPending(
      pending,
      error instanceof Error ? error : new Error(String(error)),
    );
  });
  child.once("close", (code) => {
    if (pending.size > 0) {
      failPending(
        pending,
        new Error(
          "Codex App Server exited before responding (code " +
            String(code) +
            "): " +
            stderr,
        ),
      );
    }
  });

  return {
    request(id, method, params) {
      return new Promise<unknown>((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              "Timed out waiting for Codex App Server " +
                method +
                ": " +
                stderr,
            ),
          );
        }, 15000);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timeout);
            resolvePromise(value);
          },
          reject(error) {
            clearTimeout(timeout);
            reject(error);
          },
        });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ method, params }) + "\n");
    },
    async stop() {
      if (child.exitCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => {
        child.once("close", () => resolvePromise());
        setTimeout(resolvePromise, 5000);
      });
    },
  };
}

function responseData(value: unknown): SkillsListEntry[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error(
      "Codex App Server returned an invalid skills/list response.",
    );
  }
  return value.data.filter(isSkillsListEntry);
}

function isSkillsListEntry(value: unknown): value is SkillsListEntry {
  return (
    isRecord(value) &&
    typeof value.cwd === "string" &&
    Array.isArray(value.errors) &&
    Array.isArray(value.skills)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function failPending(
  pending: Map<
    number,
    { resolve(value: unknown): void; reject(reason: Error): void }
  >,
  error: Error,
): void {
  for (const request of pending.values()) {
    request.reject(error);
  }
  pending.clear();
}

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
