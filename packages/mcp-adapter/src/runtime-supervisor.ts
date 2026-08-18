import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  RootInvoker,
  RootRequest,
  RootResult,
} from "@failure-report/protocol";

import type { RootOperationStore } from "./root-operation-store.js";

const execFileAsync = promisify(execFile);
const localEveHost = "http://127.0.0.1:2000";
const runtimeBindingPath = "/failure-report/v1/runtime";

export type RuntimeSupervisorMode = "remote" | "managed-local";

export type TrustedRepositoryProvisioning = {
  repository: string;
  checkout: string;
};

export type RuntimeSupervisorConfig = {
  mode: RuntimeSupervisorMode;
  host: string;
  bearer?: string;
  remote_repository?: string;
  trusted_repositories: readonly TrustedRepositoryProvisioning[];
  runtime_root: string;
  state_root: string;
  readiness_timeout_ms: number;
  poll_interval_ms: number;
  idle_timeout_ms: number;
};

export type RuntimeSupervisorFailureCategory =
  | "configuration_invalid"
  | "missing_provisioning"
  | "target_workspace_invalid"
  | "remote_unavailable"
  | "runtime_start_failed"
  | "readiness_timeout"
  | "binding_unverified"
  | "wrong_repository_binding"
  | "startup_in_progress";

const failureGuidance: Record<RuntimeSupervisorFailureCategory, string> = {
  configuration_invalid:
    "Repair the private FailureReport runtime-mode configuration, then restart the adapter.",
  missing_provisioning:
    "Add an operator-owned trusted repository mapping, then retry the same request_id.",
  target_workspace_invalid:
    "Repair the trusted checkout mapping or its canonical origin outside the Issue, then retry.",
  remote_unavailable:
    "Restore the configured remote Eve deployment; remote mode will not start a local replacement.",
  runtime_start_failed:
    "Inspect the private supervisor log and repair the production Eve startup failure, then retry.",
  readiness_timeout:
    "Inspect the private supervisor state and readiness log, repair the runtime, then retry.",
  binding_unverified:
    "Configure the authenticated FailureReport runtime-binding endpoint before retrying.",
  wrong_repository_binding:
    "Stop or isolate the runtime bound to the other repository; FailureReport will not reuse it.",
  startup_in_progress:
    "Wait for the existing private startup owner to finish or repair its stale process, then retry.",
};

export class RuntimeSupervisorError extends Error {
  constructor(
    readonly category: RuntimeSupervisorFailureCategory,
    message = failureGuidance[category],
  ) {
    super(message);
    this.name = "RuntimeSupervisorError";
  }
}

type RuntimeBinding = {
  schema_version: "failure-report/runtime-binding/v1";
  status: "ready";
  repository: string;
  revision: string;
  instance_id: string;
};

type RuntimeProbe =
  | { status: "unavailable" }
  | { status: "binding_unverified" }
  | { status: "ready"; binding: RuntimeBinding };

type RuntimeState = {
  schema_version: "failure-report/runtime-supervisor-state/v1";
  repository: string;
  host: string;
  instance_id: string;
  managed: boolean;
  pid?: number;
  log_path?: string;
  started_at: string;
  last_ready_at: string;
  last_activity_at: string;
  active_diagnosis: boolean;
};

type SpawnedRuntime = {
  instance_id: string;
  pid: number;
  log_path: string;
};

export type RuntimeSupervisorDependencies = {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  process_alive?: (pid: number) => boolean;
  terminate?: (pid: number) => void;
  validate_checkout?: (
    provisioning: TrustedRepositoryProvisioning,
  ) => Promise<string>;
  spawn_runtime?: (input: {
    repository: string;
    checkout: string;
    instance_id: string;
    log_path: string;
    config: RuntimeSupervisorConfig;
  }) => Promise<SpawnedRuntime>;
};

/** Reads only operator-owned process configuration; public requests cannot add paths. */
export function readRuntimeSupervisorConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): RuntimeSupervisorConfig {
  const configuredMode = environment.FAILURE_REPORT_RUNTIME_MODE?.trim();
  const mode =
    configuredMode === undefined || configuredMode === ""
      ? environment.FAILURE_REPORT_EVE_HOST?.trim()
        ? "remote"
        : "managed-local"
      : configuredMode;
  if (mode !== "remote" && mode !== "managed-local") {
    throw new RuntimeSupervisorError("configuration_invalid");
  }

  const host = environment.FAILURE_REPORT_EVE_HOST?.trim() || localEveHost;
  assertHttpHost(host);
  if (mode === "managed-local" && host !== localEveHost) {
    throw new RuntimeSupervisorError("configuration_invalid");
  }

  const runtimeRoot = resolve(
    environment.FAILURE_REPORT_RUNTIME_ROOT?.trim() || cwd,
  );
  const stateRoot = resolve(
    environment.FAILURE_REPORT_RUNTIME_STATE_ROOT?.trim() ||
      join(
        homedir(),
        ".local",
        "state",
        "failure-report",
        "runtime-supervisor",
      ),
  );
  if (!isAbsolute(runtimeRoot) || !isAbsolute(stateRoot)) {
    throw new RuntimeSupervisorError("configuration_invalid");
  }

  const trustedRepositories = parseTrustedRepositories(
    environment.FAILURE_REPORT_TRUSTED_REPOSITORIES,
  );
  const remoteRepository = environment.FAILURE_REPORT_REMOTE_REPOSITORY?.trim();
  if (remoteRepository && !isRepository(remoteRepository)) {
    throw new RuntimeSupervisorError("configuration_invalid");
  }

  return {
    mode,
    host,
    ...(environment.FAILURE_REPORT_EVE_BEARER_TOKEN?.trim()
      ? { bearer: environment.FAILURE_REPORT_EVE_BEARER_TOKEN.trim() }
      : {}),
    ...(remoteRepository ? { remote_repository: remoteRepository } : {}),
    trusted_repositories: trustedRepositories,
    runtime_root: runtimeRoot,
    state_root: stateRoot,
    readiness_timeout_ms: parseBoundedInteger(
      environment.FAILURE_REPORT_RUNTIME_READINESS_TIMEOUT_MS,
      120_000,
      100,
      900_000,
    ),
    poll_interval_ms: parseBoundedInteger(
      environment.FAILURE_REPORT_RUNTIME_POLL_INTERVAL_MS,
      250,
      10,
      10_000,
    ),
    idle_timeout_ms: parseBoundedInteger(
      environment.FAILURE_REPORT_RUNTIME_IDLE_TIMEOUT_MS,
      30 * 60_000,
      0,
      24 * 60 * 60_000,
    ),
  };
}

/** Resolves one canonical repository identity without accepting a public path. */
export function rootRequestRepository(
  request: RootRequest,
  configuredFallback?: string,
): string | undefined {
  const candidates = [
    request.issue_selector?.repository,
    request.issue?.repository,
    request.report?.shared_context?.repository,
    request.report?.target.repository,
  ].filter((value): value is string => Boolean(value));
  if (new Set(candidates).size > 1) {
    throw new RuntimeSupervisorError("wrong_repository_binding");
  }
  return candidates[0] ?? configuredFallback;
}

/** Supervises the private Eve lifecycle but never interprets or widens Root data. */
export class RuntimeSupervisor {
  private readonly starts = new Map<string, Promise<RuntimeBinding>>();
  private readonly activeInvocations = new Map<string, number>();
  private readonly cleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly processAlive: (pid: number) => boolean;
  private readonly terminate: (pid: number) => void;
  private readonly validateCheckout: (
    provisioning: TrustedRepositoryProvisioning,
  ) => Promise<string>;
  private readonly spawnRuntime: RuntimeSupervisorDependencies["spawn_runtime"];

  constructor(
    readonly config: RuntimeSupervisorConfig,
    dependencies: RuntimeSupervisorDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? delay;
    this.processAlive = dependencies.process_alive ?? defaultProcessAlive;
    this.terminate = dependencies.terminate ?? defaultTerminateRuntime;
    this.validateCheckout =
      dependencies.validate_checkout ?? validateTrustedCheckout;
    this.spawnRuntime = dependencies.spawn_runtime ?? defaultSpawnRuntime;
  }

  configuredRepositoryFallback(): string | undefined {
    if (this.config.mode === "remote") {
      return this.config.remote_repository;
    }
    return this.config.trusted_repositories.length === 1
      ? this.config.trusted_repositories[0]?.repository
      : undefined;
  }

  async ensure(repository: string): Promise<RuntimeBinding> {
    if (!isRepository(repository)) {
      throw new RuntimeSupervisorError("missing_provisioning");
    }
    if (
      this.config.mode === "remote" &&
      this.config.remote_repository &&
      repository !== this.config.remote_repository
    ) {
      throw new RuntimeSupervisorError("wrong_repository_binding");
    }

    const existing = this.starts.get(repository);
    if (existing) {
      return existing;
    }
    const start = this.ensureOnce(repository);
    this.starts.set(repository, start);
    try {
      return await start;
    } finally {
      if (this.starts.get(repository) === start) {
        this.starts.delete(repository);
      }
    }
  }

  beginInvocation(repository: string): void {
    this.activeInvocations.set(
      repository,
      (this.activeInvocations.get(repository) ?? 0) + 1,
    );
    const timer = this.cleanupTimers.get(repository);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(repository);
    }
  }

  async finishInvocation(
    repository: string,
    result?: RootResult,
  ): Promise<void> {
    const count = Math.max(
      0,
      (this.activeInvocations.get(repository) ?? 1) - 1,
    );
    if (count === 0) {
      this.activeInvocations.delete(repository);
    } else {
      this.activeInvocations.set(repository, count);
    }
    await this.recordActivity(repository, result);
    if (count === 0) {
      this.scheduleCleanup(repository);
    }
  }

  private async ensureOnce(repository: string): Promise<RuntimeBinding> {
    let checkout: string | undefined;
    if (this.config.mode === "managed-local") {
      const provisioning = this.config.trusted_repositories.find(
        (entry) => entry.repository === repository,
      );
      if (!provisioning) {
        throw new RuntimeSupervisorError("missing_provisioning");
      }
      // A listening process is not path authority. Validate the private mapping
      // before reuse as well as startup so public repository data cannot opt in.
      checkout = await this.validateCheckout(provisioning);
    }

    const probe = await this.probe();
    if (probe.status === "ready") {
      this.assertBinding(probe.binding, repository);
      await this.recordObservedRuntime(probe.binding);
      return probe.binding;
    }
    if (probe.status === "binding_unverified") {
      throw new RuntimeSupervisorError("binding_unverified");
    }
    if (this.config.mode === "remote") {
      throw new RuntimeSupervisorError("remote_unavailable");
    }
    if (!checkout) {
      throw new RuntimeSupervisorError("configuration_invalid");
    }

    return this.withStartupLock(repository, async () => {
      const afterLock = await this.probe();
      if (afterLock.status === "ready") {
        this.assertBinding(afterLock.binding, repository);
        await this.recordObservedRuntime(afterLock.binding);
        return afterLock.binding;
      }
      if (afterLock.status === "binding_unverified") {
        throw new RuntimeSupervisorError("binding_unverified");
      }
      return this.startManagedRuntime(repository, checkout);
    });
  }

  private async startManagedRuntime(
    repository: string,
    checkout: string,
  ): Promise<RuntimeBinding> {
    await this.ensureStateDirectories();
    const instanceId = randomUUID();
    const logPath = join(
      this.config.state_root,
      "logs",
      stateKey(repository) + ".log",
    );
    let spawned: SpawnedRuntime;
    try {
      spawned = await this.spawnRuntime!({
        repository,
        checkout,
        instance_id: instanceId,
        log_path: logPath,
        config: this.config,
      });
    } catch (error) {
      if (error instanceof RuntimeSupervisorError) {
        throw error;
      }
      throw new RuntimeSupervisorError("runtime_start_failed");
    }
    const now = new Date(this.now()).toISOString();
    await this.writeState({
      schema_version: "failure-report/runtime-supervisor-state/v1",
      repository,
      host: this.config.host,
      instance_id: spawned.instance_id,
      managed: true,
      pid: spawned.pid,
      log_path: spawned.log_path,
      started_at: now,
      last_ready_at: now,
      last_activity_at: now,
      active_diagnosis: false,
    });

    try {
      const deadline = this.now() + this.config.readiness_timeout_ms;
      while (this.now() < deadline) {
        if (!this.processAlive(spawned.pid)) {
          throw new RuntimeSupervisorError("runtime_start_failed");
        }
        const probe = await this.probe();
        if (probe.status === "ready") {
          this.assertBinding(probe.binding, repository, spawned.instance_id);
          await this.recordObservedRuntime(probe.binding);
          return probe.binding;
        }
        if (probe.status === "binding_unverified") {
          throw new RuntimeSupervisorError("binding_unverified");
        }
        await this.sleep(this.config.poll_interval_ms);
      }
      throw new RuntimeSupervisorError("readiness_timeout");
    } catch (error) {
      // Only the newly created process group is eligible for cleanup here;
      // an already-running runtime at the host is never terminated on mismatch.
      if (this.processAlive(spawned.pid)) {
        try {
          this.terminate(spawned.pid);
        } catch {
          // The private log/state retains the failed startup for operator
          // recovery; cleanup failure must not replace its real category.
        }
      }
      throw error;
    }
  }

  private async probe(): Promise<RuntimeProbe> {
    const headers = this.config.bearer
      ? { authorization: "Bearer " + this.config.bearer }
      : undefined;
    try {
      const health = await this.fetch(
        new URL("/eve/v1/health", this.config.host),
        {
          signal: AbortSignal.timeout(
            Math.min(5_000, this.config.readiness_timeout_ms),
          ),
        },
      );
      if (!health.ok) {
        return { status: "unavailable" };
      }
    } catch {
      return { status: "unavailable" };
    }

    try {
      const response = await this.fetch(
        new URL(runtimeBindingPath, this.config.host),
        {
          ...(headers ? { headers } : {}),
          signal: AbortSignal.timeout(
            Math.min(5_000, this.config.readiness_timeout_ms),
          ),
        },
      );
      if (!response.ok) {
        return { status: "binding_unverified" };
      }
      const binding = parseRuntimeBinding(await response.json());
      return { status: "ready", binding };
    } catch {
      return { status: "binding_unverified" };
    }
  }

  private assertBinding(
    binding: RuntimeBinding,
    repository: string,
    instanceId?: string,
  ): void {
    if (binding.repository !== repository) {
      throw new RuntimeSupervisorError("wrong_repository_binding");
    }
    if (instanceId && binding.instance_id !== instanceId) {
      throw new RuntimeSupervisorError("wrong_repository_binding");
    }
  }

  private async recordObservedRuntime(binding: RuntimeBinding): Promise<void> {
    const existing = await this.readState(binding.repository);
    const now = new Date(this.now()).toISOString();
    await this.writeState({
      schema_version: "failure-report/runtime-supervisor-state/v1",
      repository: binding.repository,
      host: this.config.host,
      instance_id: binding.instance_id,
      managed:
        existing?.instance_id === binding.instance_id
          ? existing.managed
          : false,
      ...(existing?.instance_id === binding.instance_id && existing.pid
        ? { pid: existing.pid }
        : {}),
      ...(existing?.instance_id === binding.instance_id && existing.log_path
        ? { log_path: existing.log_path }
        : {}),
      started_at:
        existing?.instance_id === binding.instance_id
          ? existing.started_at
          : now,
      last_ready_at: now,
      last_activity_at:
        existing?.instance_id === binding.instance_id
          ? existing.last_activity_at
          : now,
      active_diagnosis:
        existing?.instance_id === binding.instance_id
          ? existing.active_diagnosis
          : false,
    });
  }

  private async recordActivity(
    repository: string,
    result?: RootResult,
  ): Promise<void> {
    const state = await this.readState(repository);
    if (!state) {
      return;
    }
    const lifecycle = result?.report?.diagnostic_session?.lifecycle;
    await this.writeState({
      ...state,
      last_activity_at: new Date(this.now()).toISOString(),
      active_diagnosis:
        lifecycle === "active"
          ? true
          : lifecycle === "finalized"
            ? false
            : state.active_diagnosis,
    });
  }

  private scheduleCleanup(repository: string): void {
    if (
      this.config.mode !== "managed-local" ||
      this.config.idle_timeout_ms === 0
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(repository);
      void this.cleanupIfIdle(repository);
    }, this.config.idle_timeout_ms);
    timer.unref?.();
    this.cleanupTimers.set(repository, timer);
  }

  private async cleanupIfIdle(repository: string): Promise<void> {
    if ((this.activeInvocations.get(repository) ?? 0) > 0) {
      this.scheduleCleanup(repository);
      return;
    }
    const state = await this.readState(repository);
    if (
      !state?.managed ||
      !state.pid ||
      state.active_diagnosis ||
      this.now() - Date.parse(state.last_activity_at) <
        this.config.idle_timeout_ms
    ) {
      return;
    }
    const probe = await this.probe();
    if (
      probe.status !== "ready" ||
      probe.binding.repository !== repository ||
      probe.binding.instance_id !== state.instance_id ||
      !this.processAlive(state.pid)
    ) {
      return;
    }
    this.terminate(state.pid);
  }

  private async withStartupLock(
    repository: string,
    operation: () => Promise<RuntimeBinding>,
  ): Promise<RuntimeBinding> {
    await this.ensureStateDirectories();
    const lockPath = this.lockPath(repository);
    let acquired = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
      if (await this.reclaimStaleLock(lockPath)) {
        await mkdir(lockPath, { mode: 0o700 });
        acquired = true;
      }
    }
    if (!acquired) {
      const deadline = this.now() + this.config.readiness_timeout_ms;
      while (this.now() < deadline) {
        const probe = await this.probe();
        if (probe.status === "ready") {
          this.assertBinding(probe.binding, repository);
          return probe.binding;
        }
        await this.sleep(this.config.poll_interval_ms);
      }
      throw new RuntimeSupervisorError("startup_in_progress");
    }

    const ownerPath = join(lockPath, "owner.json");
    await writeFile(
      ownerPath,
      JSON.stringify({ pid: process.pid, repository }) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      return await operation();
    } finally {
      await unlink(ownerPath).catch(() => undefined);
      await rmdir(lockPath).catch(() => undefined);
    }
  }

  private async reclaimStaleLock(lockPath: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(
        await readFile(join(lockPath, "owner.json"), "utf8"),
      ) as { pid?: unknown };
      if (
        typeof parsed.pid === "number" &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0 &&
        this.processAlive(parsed.pid)
      ) {
        return false;
      }
      await unlink(join(lockPath, "owner.json")).catch(() => undefined);
      await rmdir(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureStateDirectories(): Promise<void> {
    await mkdir(this.config.state_root, { recursive: true, mode: 0o700 });
    await chmod(this.config.state_root, 0o700);
    const logsRoot = join(this.config.state_root, "logs");
    await mkdir(logsRoot, {
      recursive: true,
      mode: 0o700,
    });
    await chmod(logsRoot, 0o700);
  }

  private statePath(repository: string): string {
    return join(this.config.state_root, stateKey(repository) + ".json");
  }

  private lockPath(repository: string): string {
    return join(this.config.state_root, stateKey(repository) + ".lock");
  }

  private async readState(
    repository: string,
  ): Promise<RuntimeState | undefined> {
    try {
      return parseRuntimeState(
        JSON.parse(await readFile(this.statePath(repository), "utf8")),
        repository,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      throw new RuntimeSupervisorError("configuration_invalid");
    }
  }

  private async writeState(state: RuntimeState): Promise<void> {
    await this.ensureStateDirectories();
    const path = this.statePath(state.repository);
    // Same-repository callers finish concurrently, so each atomic replacement
    // needs a unique staging name even though the final state path is shared.
    const temporaryPath =
      path + "." + process.pid + "." + randomUUID() + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(state, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  }
}

/** Keeps runtime failure/recovery outside the strict public Root schema. */
export class RuntimeSupervisedRootInvoker implements RootInvoker {
  constructor(
    private readonly inner: RootInvoker & {
      resumePendingOperations?: () => Promise<void>;
    },
    private readonly supervisor: RuntimeSupervisor,
    private readonly operationStore?: RootOperationStore,
  ) {}

  async invoke(request: RootRequest): Promise<RootResult> {
    let repository: string | undefined;
    try {
      repository = rootRequestRepository(
        request,
        this.supervisor.configuredRepositoryFallback(),
      );
      if (!repository) {
        throw new RuntimeSupervisorError("missing_provisioning");
      }
      await this.supervisor.ensure(repository);
    } catch (error) {
      return runtimePendingResult(request, error);
    }

    this.supervisor.beginInvocation(repository);
    let result: RootResult | undefined;
    try {
      result = await this.inner.invoke(request);
      return result;
    } finally {
      await this.supervisor.finishInvocation(repository, result);
    }
  }

  async resumePendingOperations(): Promise<void> {
    if (!this.inner.resumePendingOperations) {
      return;
    }
    if (!this.operationStore) {
      await this.inner.resumePendingOperations();
      return;
    }
    const repositories = new Set<string>();
    for (const key of await this.operationStore.listSessionKeys()) {
      const ledger = await this.operationStore.readLedger(key);
      if (!ledger || (!ledger.active_request_id && ledger.queue.length === 0)) {
        continue;
      }
      for (const operation of Object.values(ledger.operations)) {
        if (operation.state !== "prepared" && operation.state !== "delivered") {
          continue;
        }
        const repository = rootRequestRepository(
          operation.request,
          this.supervisor.configuredRepositoryFallback(),
        );
        if (repository) {
          repositories.add(repository);
        }
      }
    }
    for (const repository of repositories) {
      try {
        await this.supervisor.ensure(repository);
      } catch {
        return;
      }
    }
    await this.inner.resumePendingOperations();
  }
}

function runtimePendingResult(
  request: RootRequest,
  error: unknown,
): RootResult {
  const category =
    error instanceof RuntimeSupervisorError
      ? error.category
      : "configuration_invalid";
  return {
    request_id: request.request_id,
    status: "failed",
    summary:
      "FailureReport runtime pending [" +
      category +
      "]. " +
      failureGuidance[category] +
      " The GitHub Issue and Root request identity were preserved; no Root turn was started.",
  };
}

function parseTrustedRepositories(
  configured: string | undefined,
): readonly TrustedRepositoryProvisioning[] {
  if (!configured?.trim()) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(configured);
  } catch {
    throw new RuntimeSupervisorError("configuration_invalid");
  }
  if (!isRecord(value) || !Array.isArray(value.repositories)) {
    throw new RuntimeSupervisorError("configuration_invalid");
  }
  const repositories: TrustedRepositoryProvisioning[] = [];
  const identities = new Set<string>();
  for (const entry of value.repositories) {
    if (
      !isRecord(entry) ||
      !isRepository(entry.repository) ||
      typeof entry.checkout !== "string" ||
      !isAbsolute(entry.checkout) ||
      identities.has(entry.repository)
    ) {
      throw new RuntimeSupervisorError("configuration_invalid");
    }
    identities.add(entry.repository);
    repositories.push({
      repository: entry.repository,
      checkout: entry.checkout,
    });
  }
  return repositories;
}

async function validateTrustedCheckout(
  provisioning: TrustedRepositoryProvisioning,
): Promise<string> {
  let declared: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    declared = await lstat(provisioning.checkout);
    canonical = await realpath(provisioning.checkout);
  } catch {
    throw new RuntimeSupervisorError("target_workspace_invalid");
  }
  if (declared.isSymbolicLink() || !declared.isDirectory()) {
    throw new RuntimeSupervisorError("target_workspace_invalid");
  }
  try {
    const topLevel = (
      await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: canonical,
      })
    ).stdout.trim();
    if ((await realpath(topLevel)) !== canonical) {
      throw new Error("not canonical top level");
    }
    const origin = (
      await execFileAsync("git", ["remote", "get-url", "origin"], {
        cwd: canonical,
      })
    ).stdout.trim();
    if (repositoryFromRemote(origin) !== provisioning.repository) {
      throw new Error("origin mismatch");
    }
  } catch {
    throw new RuntimeSupervisorError("target_workspace_invalid");
  }
  return canonical;
}

async function defaultSpawnRuntime(input: {
  repository: string;
  checkout: string;
  instance_id: string;
  log_path: string;
  config: RuntimeSupervisorConfig;
}): Promise<SpawnedRuntime> {
  const manifest = resolve(input.config.runtime_root, "eve", "package.json");
  if (!(await lstat(manifest).catch(() => undefined))) {
    throw new RuntimeSupervisorError("configuration_invalid");
  }
  const log = await open(input.log_path, "a", 0o600);
  try {
    await chmod(input.log_path, 0o600);
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@Alive24/FailureReport",
        "start",
        "--",
        "--target-workspace",
        input.checkout,
      ],
      {
        cwd: input.config.runtime_root,
        detached: true,
        env: {
          ...process.env,
          FAILURE_REPORT_RUNTIME_INSTANCE_ID: input.instance_id,
        },
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const handleError = (error: Error) => rejectSpawn(error);
      child.once("error", handleError);
      child.once("spawn", () => {
        child.off("error", handleError);
        // A later child-process error is reflected by liveness/readiness; keep
        // it from becoming an unhandled adapter exception after spawn succeeds.
        child.on("error", () => undefined);
        resolveSpawn();
      });
    });
    if (!child.pid) {
      throw new RuntimeSupervisorError("runtime_start_failed");
    }
    child.unref();
    return {
      instance_id: input.instance_id,
      pid: child.pid,
      log_path: input.log_path,
    };
  } finally {
    await log.close();
  }
}

function parseRuntimeBinding(value: unknown): RuntimeBinding {
  if (
    !isRecord(value) ||
    value.schema_version !== "failure-report/runtime-binding/v1" ||
    value.status !== "ready" ||
    !isRepository(value.repository) ||
    typeof value.revision !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(value.revision) ||
    typeof value.instance_id !== "string" ||
    !/^[a-zA-Z0-9._:-]+$/.test(value.instance_id)
  ) {
    throw new RuntimeSupervisorError("binding_unverified");
  }
  return value as RuntimeBinding;
}

function parseRuntimeState(value: unknown, repository: string): RuntimeState {
  if (
    !isRecord(value) ||
    value.schema_version !== "failure-report/runtime-supervisor-state/v1" ||
    value.repository !== repository ||
    typeof value.host !== "string" ||
    typeof value.instance_id !== "string" ||
    typeof value.managed !== "boolean" ||
    typeof value.started_at !== "string" ||
    typeof value.last_ready_at !== "string" ||
    typeof value.last_activity_at !== "string" ||
    typeof value.active_diagnosis !== "boolean" ||
    (value.pid !== undefined &&
      (typeof value.pid !== "number" || !Number.isInteger(value.pid))) ||
    (value.log_path !== undefined && typeof value.log_path !== "string")
  ) {
    throw new RuntimeSupervisorError("configuration_invalid");
  }
  return value as RuntimeState;
}

function repositoryFromRemote(remote: string): string {
  const normalized = remote
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const match = normalized.match(/(?:[:/])([^/:\s]+)\/([^/\s]+)$/);
  const repository = match ? match[1] + "/" + match[2] : undefined;
  if (!isRepository(repository)) {
    throw new Error("invalid remote");
  }
  return repository;
}

function stateKey(repository: string): string {
  return createHash("sha256").update(repository, "utf8").digest("hex");
}

function parseBoundedInteger(
  configured: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!configured?.trim()) {
    return fallback;
  }
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RuntimeSupervisorError("configuration_invalid");
  }
  return parsed;
}

function assertHttpHost(host: string): void {
  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    throw new RuntimeSupervisorError("configuration_invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new RuntimeSupervisorError("configuration_invalid");
  }
}

function isRepository(value: unknown): value is string {
  return typeof value === "string" && /^[^/\s]+\/[^/\s]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultTerminateRuntime(pid: number): void {
  // Managed-local startup creates a detached process group so terminating only
  // the pnpm wrapper cannot orphan the launcher or Eve child behind it.
  process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}
