import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const targetWorkspaceVariable = "FAILURE_REPORT_TARGET_WORKSPACE";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDirectory, "..");
const eveCli = resolve(appRoot, "node_modules", "eve", "bin", "eve.js");
const readinessCli = resolve(
  appRoot,
  "dist",
  "agent",
  "lib",
  "host-runtime-preflight-cli.js",
);

const guidance = {
  target_workspace_invalid:
    "The process-bound target workspace is invalid or inaccessible. Verify that it is the real canonical Git checkout with a readable origin, then restart FailureReport.",
  watcher_exhaustion:
    "The watcher-based development runtime exhausted host file descriptors. Use the supported no-watch start command or repair host watcher capacity outside FailureReport.",
};

export async function launchEveRuntime({ mode }) {
  try {
    const { targetWorkspace, eveArguments } = parseArguments(
      process.argv.slice(2),
    );
    const canonicalTargetWorkspace = await validateTargetWorkspace(
      targetWorkspace ?? process.env[targetWorkspaceVariable],
    );
    if (mode !== "development") {
      await validateProductionOutput();
    }
    const environment = {
      ...process.env,
      [targetWorkspaceVariable]: canonicalTargetWorkspace,
    };
    await runReadinessPreflight(environment);
    const runtimeRoot =
      mode === "demo"
        ? await createIsolatedRuntimeRoot()
        : mode === "production"
          ? await createPersistentRuntimeRoot()
          : appRoot;
    if (mode === "demo") {
      console.log(
        `Using isolated Eve workflow state at ${resolve(runtimeRoot, ".eve")}`,
      );
    }
    spawnEve({ mode, runtimeRoot, environment, eveArguments });
  } catch (error) {
    if (error instanceof ReadinessPreflightFailed) {
      process.exitCode = 1;
      return;
    }
    logLauncherFailure("launcher-startup", "target_workspace_invalid");
    console.error(
      "FailureReport launcher failed: " + guidance.target_workspace_invalid,
    );
    process.exitCode = 1;
  }
}

function spawnEve({ mode, runtimeRoot, environment, eveArguments }) {
  const command =
    mode === "development"
      ? ["dev", "--no-ui", ...eveArguments]
      : ["start", "--host", "127.0.0.1", "--port", "2000", ...eveArguments];
  const child = spawn(process.execPath, [eveCli, ...command], {
    cwd: runtimeRoot,
    env: environment,
    stdio: ["inherit", "inherit", "pipe"],
  });
  let watcherExhausted = false;
  child.stderr.on("data", (chunk) => {
    if (mode === "development" && /\bEMFILE\b/.test(String(chunk))) {
      watcherExhausted = true;
    }
    process.stderr.write(chunk);
  });
  child.once("error", (error) => {
    const category =
      mode === "development" && /\bEMFILE\b/.test(String(error))
        ? "watcher_exhaustion"
        : "target_workspace_invalid";
    logLauncherFailure("eve-process-start", category);
    console.error("FailureReport could not start Eve: " + guidance[category]);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (watcherExhausted) {
      logLauncherFailure("eve-development-watcher", "watcher_exhaustion");
      console.error(guidance.watcher_exhaustion);
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

async function runReadinessPreflight(environment) {
  await lstat(readinessCli).catch(() => {
    throw new Error("Missing compiled host-runtime preflight.");
  });
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [readinessCli], {
      cwd: appRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolvePromise(exitCode ?? 1));
  });
  if (code !== 0) {
    throw new ReadinessPreflightFailed();
  }
}

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
  if (!targetWorkspace || !isAbsolute(targetWorkspace)) {
    throw new Error("A canonical absolute target workspace is required.");
  }
  const declared = await lstat(targetWorkspace);
  if (declared.isSymbolicLink() || !declared.isDirectory()) {
    throw new Error("The target workspace must be a real directory.");
  }
  return realpath(targetWorkspace);
}

async function validateProductionOutput() {
  const output = await lstat(resolve(appRoot, ".output"));
  if (!output.isDirectory()) {
    throw new Error("Missing Eve production output.");
  }
}

async function createIsolatedRuntimeRoot() {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "failure-report-eve-demo-"));
  await provisionRuntimeRoot(runtimeRoot);
  return runtimeRoot;
}

async function createPersistentRuntimeRoot() {
  const runtimeRoot = resolve(appRoot, ".failure-report-runtime");
  await mkdir(runtimeRoot, { recursive: true });
  await provisionRuntimeRoot(runtimeRoot);
  return runtimeRoot;
}

async function provisionRuntimeRoot(runtimeRoot) {
  await Promise.all(
    ["agent", ".output", "package.json", "tsconfig.json"].map((name) =>
      ensureSymlink(resolve(appRoot, name), resolve(runtimeRoot, name)),
    ),
  );
}

async function ensureSymlink(target, path) {
  try {
    const declared = await lstat(path);
    if (!declared.isSymbolicLink()) {
      throw new Error("Persistent runtime entry is not a symlink.");
    }
    if ((await realpath(path)) !== (await realpath(target))) {
      throw new Error("Persistent runtime symlink has an unexpected target.");
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    await symlink(target, path);
  }
}

function isNotFoundError(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function logLauncherFailure(boundary, category) {
  console.error(
    JSON.stringify({
      event: "failure-report.runtime-failure",
      boundary,
      category,
    }),
  );
}

class ReadinessPreflightFailed extends Error {}
