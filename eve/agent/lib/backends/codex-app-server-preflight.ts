import { isAbsolute } from "node:path";

import {
  CodexAppServerProtocolError,
  CodexAppServerTransportError,
  nodeCodexAppServerHostRuntime,
  type CodexAppServerHostRuntime,
  type CodexAppServerProcess,
} from "./codex-app-server-transport.js";

/** Bounded readiness timeout for one short-lived App Server preflight. */
const defaultPreflightTimeoutMs = 10_000;
const maximumCapturedDiagnosticChars = 4_096;

export type {
  CodexAppServerHostRuntime,
  CodexAppServerProcess,
} from "./codex-app-server-transport.js";

/** Sanitized reason a Root caller can act on without receiving host state details. */
export type CodexAppServerPreflightFailureCategory =
  | "executable_unavailable"
  | "state_inaccessible"
  | "credentials_unavailable"
  | "workspace_invalid"
  | "project_skill_missing"
  | "timeout"
  | "startup_failed";

/** Result of the bounded App Server readiness exchange. */
export type CodexAppServerPreflightResult =
  | {
      status: "ready";
      attempts: 1 | 2;
    }
  | {
      status: "needs_input";
      category: CodexAppServerPreflightFailureCategory;
      reason: string;
      attempts: 1 | 2;
    };

/** Root-validated worktree details used only for the preflight transport. */
export type CodexAppServerPreflightWorkspace = {
  path: string;
  native_skill_names: readonly string[];
};

/**
 * Root-only preflight input. It is assembled from backend configuration and a
 * prepared workpad, never from the caller-facing diagnostic tool input.
 */
export type CodexAppServerPreflightInput = {
  executable: string;
  workspace: CodexAppServerPreflightWorkspace;
  /**
   * Limited recovery hook for one transient failure. Root uses it to restore
   * the same managed worktree and re-materialize only known native skills.
   */
  revalidate_workspace?: () => Promise<CodexAppServerPreflightWorkspace>;
};

/** Injectable boundaries for deterministic preflight coverage. */
export type CodexAppServerPreflightDependencies = {
  host_runtime?: CodexAppServerHostRuntime;
  timeout_ms?: number;
};

type AttemptFailure = {
  category: CodexAppServerPreflightFailureCategory;
  retryable: boolean;
};

type AttemptPhase = "startup" | "initialize" | "skills";

/**
 * Builds Root's mandatory host-runtime readiness gate.
 *
 * The exchange deliberately stops after `initialize` and `skills/list`: it does
 * not create a thread, issue a model request, invoke a native tool, or mutate a
 * target repository. Every launched child is terminated before a result returns.
 */
export function createCodexAppServerPreflight(
  dependencies: CodexAppServerPreflightDependencies = {},
): (
  input: CodexAppServerPreflightInput,
) => Promise<CodexAppServerPreflightResult> {
  const hostRuntime =
    dependencies.host_runtime ?? nodeCodexAppServerHostRuntime;
  const timeoutMs = dependencies.timeout_ms ?? defaultPreflightTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Codex App Server preflight timeout must be positive.");
  }

  return async (input) => {
    let workspace = input.workspace;
    const initialWorkspaceFailure = validateWorkspace(workspace);
    if (initialWorkspaceFailure) {
      return needsInput(initialWorkspaceFailure, 1);
    }

    for (const attempt of [1, 2] as const) {
      const outcome = await runAttempt({
        executable: input.executable,
        workspace,
        hostRuntime,
        timeoutMs,
      });
      if (!outcome) {
        return { status: "ready", attempts: attempt };
      }
      if (!outcome.retryable || attempt === 2) {
        return needsInput(outcome.category, attempt);
      }

      try {
        workspace = input.revalidate_workspace
          ? await input.revalidate_workspace()
          : workspace;
      } catch {
        return needsInput("workspace_invalid", attempt);
      }
      const workspaceFailure = validateWorkspace(workspace);
      if (workspaceFailure) {
        return needsInput(workspaceFailure, attempt);
      }
    }

    return needsInput("startup_failed", 2);
  };
}

async function runAttempt(input: {
  executable: string;
  workspace: CodexAppServerPreflightWorkspace;
  hostRuntime: CodexAppServerHostRuntime;
  timeoutMs: number;
}): Promise<AttemptFailure | undefined> {
  let process: CodexAppServerProcess | undefined;
  let cleanup: Promise<void> | undefined;
  let attemptFinished = false;
  let phase: AttemptPhase = "startup";

  const cleanupProcess = (): Promise<void> => {
    if (!process) {
      return Promise.resolve();
    }
    cleanup ??= disposeSafely(process);
    return cleanup;
  };

  const exchange = (async () => {
    const started = await input.hostRuntime.startAppServer({
      executable: input.executable,
      cwd: input.workspace.path,
    });
    if (attemptFinished) {
      await disposeSafely(started);
      throw new CodexAppServerTransportError(
        "App Server startup outlived preflight.",
      );
    }
    process = started;

    phase = "initialize";
    await process.request("initialize", {
      clientInfo: {
        name: "failure-report-host-runtime-preflight",
        title: "FailureReport host-runtime preflight",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    process.notify("initialized", {});

    phase = "skills";
    const listed = await process.request("skills/list", {
      cwds: [input.workspace.path],
      forceReload: true,
    });
    assertExpectedProjectSkills(listed, input.workspace);
  })();

  try {
    await withTimeout(exchange, input.timeoutMs, () => {
      attemptFinished = true;
      void cleanupProcess();
    });
    return undefined;
  } catch (error) {
    return classifyFailure(error, phase);
  } finally {
    attemptFinished = true;
    await cleanupProcess();
    // A delayed process launch still cleans itself up through `attemptFinished`.
    void exchange.catch(() => undefined);
  }
}

/** Validates the portion of `skills/list` needed for repository-native skills. */
function assertExpectedProjectSkills(
  response: unknown,
  workspace: CodexAppServerPreflightWorkspace,
): void {
  if (!isRecord(response) || !Array.isArray(response.data)) {
    throw new CodexAppServerProtocolError(
      "skills/list returned an invalid response.",
    );
  }
  const entry = response.data.find(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.cwd === "string" &&
      candidate.cwd === workspace.path,
  );
  if (!entry) {
    throw new PreflightWorkspaceError(
      "skills/list did not acknowledge the prepared worktree.",
    );
  }
  if (!Array.isArray(entry.errors) || !Array.isArray(entry.skills)) {
    throw new CodexAppServerProtocolError(
      "skills/list entry has an invalid shape.",
    );
  }
  if (entry.errors.length > 0) {
    const detail = diagnosticText(entry.errors);
    if (/(cwd|workspace|worktree|directory|path|permission)/i.test(detail)) {
      throw new PreflightWorkspaceError(detail);
    }
    throw new PreflightSkillError(detail);
  }

  const discovered = new Set<string>();
  for (const skill of entry.skills) {
    if (
      isRecord(skill) &&
      typeof skill.name === "string" &&
      skill.scope === "repo"
    ) {
      discovered.add(skill.name);
    }
  }
  if (workspace.native_skill_names.some((name) => !discovered.has(name))) {
    throw new PreflightSkillError(
      "skills/list did not return every Root-selected project skill.",
    );
  }
}

/** Rejects malformed internal state before it can reach a child process. */
function validateWorkspace(
  workspace: CodexAppServerPreflightWorkspace,
): CodexAppServerPreflightFailureCategory | undefined {
  if (
    !isAbsolute(workspace.path) ||
    workspace.native_skill_names.length === 0 ||
    workspace.native_skill_names.some(
      (name, index) =>
        !/^[a-z][a-z0-9-]*$/.test(name) ||
        (index > 0 && workspace.native_skill_names[index - 1]! >= name),
    )
  ) {
    return "workspace_invalid";
  }
  return undefined;
}

function classifyFailure(error: unknown, phase: AttemptPhase): AttemptFailure {
  if (error instanceof PreflightTimeoutError) {
    return { category: "timeout", retryable: true };
  }
  if (error instanceof PreflightWorkspaceError) {
    return { category: "workspace_invalid", retryable: false };
  }
  if (error instanceof PreflightSkillError) {
    return { category: "project_skill_missing", retryable: false };
  }

  const detail = diagnosticText(error);
  const code = errorCode(error);
  if (
    code === "ENOENT" ||
    code === "EACCES" ||
    /\b(ENOENT|EACCES)\b|executable.*(?:not found|unavailable)|command not found/i.test(
      detail,
    )
  ) {
    return { category: "executable_unavailable", retryable: false };
  }
  if (
    /(readonly database|sqlite|unable to open database|read-only file system|codex.*(?:state|home).*permission|state.*access)/i.test(
      detail,
    ) ||
    (phase === "initialize" &&
      /permission denied|operation not permitted/i.test(detail))
  ) {
    return { category: "state_inaccessible", retryable: false };
  }
  if (
    /(not logged in|login required|authentication|unauthori[sz]ed|credential|api key|access token|\b401\b)/i.test(
      detail,
    )
  ) {
    return { category: "credentials_unavailable", retryable: false };
  }
  if (
    phase === "skills" &&
    /permission denied|operation not permitted/i.test(detail)
  ) {
    return { category: "workspace_invalid", retryable: false };
  }
  if (error instanceof CodexAppServerProtocolError) {
    return { category: "startup_failed", retryable: true };
  }
  return { category: "startup_failed", retryable: true };
}

function needsInput(
  category: CodexAppServerPreflightFailureCategory,
  attempts: 1 | 2,
): CodexAppServerPreflightResult {
  return {
    status: "needs_input",
    category,
    reason: preflightGuidance[category],
    attempts,
  };
}

const preflightGuidance: Record<
  CodexAppServerPreflightFailureCategory,
  string
> = {
  executable_unavailable:
    "Codex App Server is unavailable in this host context. Run Root from a normal host terminal where the configured Codex executable is already available, then retry.",
  state_inaccessible:
    "Codex App Server cannot access its existing ambient runtime state in this host context. Run Root from a normal host terminal that can use the existing Codex runtime, then retry.",
  credentials_unavailable:
    "Codex App Server cannot authenticate with the ambient Codex runtime. Restore sign-in or access outside FailureReport, then retry from a normal host terminal.",
  workspace_invalid:
    "The Root-owned diagnostic workspace could not be revalidated safely. Revalidate the Root-managed workspace and selected native skills, then retry.",
  project_skill_missing:
    "Codex App Server did not discover every Root-selected project skill. Revalidate the Root-managed workspace and selected native skills, then retry.",
  timeout:
    "Codex App Server readiness timed out after one clean retry. Start Root from a normal host terminal; restrictive desktop processes may not support the required Codex runtime access.",
  startup_failed:
    "Codex App Server could not complete bounded readiness after one clean retry. Start Root from a normal host terminal with the existing Codex runtime, then retry.",
};

/** Runs an operation with one bounded timeout without exposing its raw failure. */
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new PreflightTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

class PreflightTimeoutError extends Error {
  constructor() {
    super("Codex App Server readiness timed out.");
  }
}

class PreflightWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
  }
}

class PreflightSkillError extends Error {
  constructor(message: string) {
    super(message);
  }
}

async function disposeSafely(
  process: CodexAppServerProcess | undefined,
): Promise<void> {
  try {
    await process?.dispose();
  } catch {
    // Cleanup is best effort; the bounded result still must not leak raw errors.
  }
}

function diagnosticText(value: unknown): string {
  if (value instanceof Error) {
    return value.message.slice(0, maximumCapturedDiagnosticChars);
  }
  if (typeof value === "string") {
    return value.slice(0, maximumCapturedDiagnosticChars);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const detail = diagnosticText(entry);
      if (detail !== "Codex App Server returned an unknown failure.") {
        return detail;
      }
    }
  }
  if (isRecord(value)) {
    const message = value.message;
    if (typeof message === "string") {
      return message.slice(0, maximumCapturedDiagnosticChars);
    }
    const error = value.error;
    if (typeof error === "string") {
      return error.slice(0, maximumCapturedDiagnosticChars);
    }
  }
  return "Codex App Server returned an unknown failure.";
}

function errorCode(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.code === "string") {
    return value.code;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
