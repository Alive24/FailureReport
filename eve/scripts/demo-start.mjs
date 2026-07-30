#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const targetWorkspaceVariable = "FAILURE_REPORT_TARGET_WORKSPACE";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDirectory, "..");
const eveCli = resolve(appRoot, "node_modules", "eve", "bin", "eve.js");

const { targetWorkspace, eveArguments } = parseArguments(process.argv.slice(2));
const canonicalTargetWorkspace = await validateTargetWorkspace(
  targetWorkspace ?? process.env[targetWorkspaceVariable],
);
await validateProductionOutput();

const runtimeRoot = await mkdtemp(join(tmpdir(), "failure-report-eve-demo-"));
await Promise.all([
  symlink(resolve(appRoot, "agent"), resolve(runtimeRoot, "agent")),
  symlink(resolve(appRoot, ".output"), resolve(runtimeRoot, ".output")),
  symlink(
    resolve(appRoot, "package.json"),
    resolve(runtimeRoot, "package.json"),
  ),
  symlink(
    resolve(appRoot, "tsconfig.json"),
    resolve(runtimeRoot, "tsconfig.json"),
  ),
]);

console.log(
  `Using isolated Eve workflow state at ${resolve(runtimeRoot, ".eve")}`,
);

const child = spawn(
  process.execPath,
  [eveCli, "start", "--host", "127.0.0.1", "--port", "2000", ...eveArguments],
  {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      [targetWorkspaceVariable]: canonicalTargetWorkspace,
    },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error("Failed to start the demo Eve process:", error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

function parseArguments(arguments_) {
  let targetWorkspace;
  const eveArguments = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--target-workspace") {
      if (targetWorkspace !== undefined) {
        throw new Error("--target-workspace may be provided only once.");
      }
      targetWorkspace = arguments_[index + 1];
      if (!targetWorkspace) {
        throw new Error("--target-workspace requires a path.");
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--target-workspace=")) {
      if (targetWorkspace !== undefined) {
        throw new Error("--target-workspace may be provided only once.");
      }
      targetWorkspace = argument.slice("--target-workspace=".length);
      if (!targetWorkspace) {
        throw new Error("--target-workspace requires a path.");
      }
      continue;
    }
    eveArguments.push(argument);
  }
  return { targetWorkspace, eveArguments };
}

async function validateTargetWorkspace(configuredPath) {
  const targetWorkspace = configuredPath?.trim();
  if (!targetWorkspace) {
    throw new Error(
      "Start the demo with --target-workspace <canonical-checkout>.",
    );
  }
  if (!isAbsolute(targetWorkspace)) {
    throw new Error("--target-workspace must be an absolute path.");
  }
  const declared = await lstat(targetWorkspace);
  if (declared.isSymbolicLink() || !declared.isDirectory()) {
    throw new Error(
      "--target-workspace must be a real directory, not a symlink or file.",
    );
  }
  return realpath(targetWorkspace);
}

async function validateProductionOutput() {
  const output = await lstat(resolve(appRoot, ".output"));
  if (!output.isDirectory()) {
    throw new Error(
      "Missing Eve production output. Run `pnpm exec eve build --skip-sandbox-prewarm` first.",
    );
  }
}
