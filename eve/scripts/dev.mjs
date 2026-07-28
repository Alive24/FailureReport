#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const targetWorkspaceVariable = "FAILURE_REPORT_TARGET_WORKSPACE";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const eveCli = resolve(
  scriptDirectory,
  "..",
  "node_modules",
  "eve",
  "bin",
  "eve.js",
);

const { targetWorkspace, eveArguments } = parseArguments(process.argv.slice(2));
const canonicalTargetWorkspace = await validateTargetWorkspace(
  targetWorkspace ?? process.env[targetWorkspaceVariable],
);

const child = spawn(
  process.execPath,
  [eveCli, "dev", "--no-ui", ...eveArguments],
  {
    cwd: resolve(scriptDirectory, ".."),
    env: {
      ...process.env,
      [targetWorkspaceVariable]: canonicalTargetWorkspace,
    },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error("Failed to start Eve:", error.message);
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
      "Start FailureReport with --target-workspace <canonical-checkout>.",
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
