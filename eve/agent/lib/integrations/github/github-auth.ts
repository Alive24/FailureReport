import { spawn } from "node:child_process";

import { App, Octokit } from "octokit";
import type { Octokit as OctokitClient } from "octokit";

/**
 * Authentication adapters for the Root-owned Octokit client.
 *
 * The default intentionally reuses an existing local `gh auth login`; token and
 * GitHub App forms are explicit runtime-only alternatives for other hosts.
 */

/** Read-only environment interface so credential parsing can be tested safely. */
export type GithubEnvironment = Readonly<Record<string, string | undefined>>;

/** Authentication that obtains a token from an active GitHub CLI session. */
export type GithubGhCliAuthConfig = {
  kind: "gh-cli";
  executable: string;
  hostname?: string;
  baseUrl?: string;
};

/** Authentication backed by an explicitly injected personal or service token. */
export type GithubTokenAuthConfig = {
  kind: "token";
  token: string;
  baseUrl?: string;
};

/** Authentication backed by a GitHub App installation. */
export type GithubAppAuthConfig = {
  kind: "app";
  appId: string;
  privateKey: string;
  installationId: number;
  baseUrl?: string;
};

/** Discriminated authentication options accepted by the Octokit factory. */
export type GithubAuthConfig =
  GithubGhCliAuthConfig | GithubTokenAuthConfig | GithubAppAuthConfig;

/** Options passed when constructing a token-authenticated Octokit client. */
export type GithubTokenOctokitOptions = {
  auth: string;
  baseUrl?: string;
};

/** Options required to construct a GitHub App installation client. */
export type GithubInstallationOctokitOptions = {
  appId: string;
  privateKey: string;
  installationId: number;
  baseUrl?: string;
};

/** Injectable side effects for token lookup and Octokit construction. */
export type GithubAuthenticationDependencies = {
  readGhToken?: (config: GithubGhCliAuthConfig) => Promise<string>;
  createTokenOctokit?: (options: GithubTokenOctokitOptions) => OctokitClient;
  createInstallationOctokit?: (
    options: GithubInstallationOctokitOptions,
  ) => Promise<OctokitClient>;
};

/**
 * Reads GitHub authentication configuration without leaking credentials into any
 * protocol, workpad, prompt, or log object.
 */
export function readGithubAuthConfig(
  environment: GithubEnvironment = process.env,
): GithubAuthConfig {
  const mode = (environment.FAILURE_REPORT_GITHUB_AUTH ?? "gh-cli").trim();
  const baseUrl = optionalEnvironment(
    environment,
    "FAILURE_REPORT_GITHUB_API_URL",
  );

  switch (mode) {
    case "gh-cli":
      return {
        kind: "gh-cli",
        executable:
          optionalEnvironment(environment, "FAILURE_REPORT_GH_EXECUTABLE") ??
          "gh",
        hostname: optionalEnvironment(
          environment,
          "FAILURE_REPORT_GITHUB_HOST",
        ),
        baseUrl,
      };
    case "token":
      return {
        kind: "token",
        token: requiredEnvironment(environment, "GITHUB_TOKEN"),
        baseUrl,
      };
    case "app":
      return {
        kind: "app",
        appId: requiredEnvironment(environment, "GITHUB_APP_ID"),
        privateKey: requiredEnvironment(
          environment,
          "GITHUB_APP_PRIVATE_KEY",
        ).replace(/\\n/g, "\n"),
        installationId: parseInstallationId(
          requiredEnvironment(environment, "GITHUB_APP_INSTALLATION_ID"),
        ),
        baseUrl,
      };
    default:
      throw new Error(
        "FAILURE_REPORT_GITHUB_AUTH must be gh-cli, token, or app.",
      );
  }
}

/**
 * Constructs an authenticated Octokit client from parsed configuration.
 * GitHub App installation tokens are delegated to Octokit's App support; other
 * modes produce a normal token-authenticated client.
 */
export async function createAuthenticatedOctokit(
  config: GithubAuthConfig,
  dependencies: GithubAuthenticationDependencies = {},
): Promise<OctokitClient> {
  if (config.kind === "app") {
    return (
      dependencies.createInstallationOctokit ?? createInstallationOctokit
    )({
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
      baseUrl: config.baseUrl,
    });
  }

  const token =
    config.kind === "gh-cli"
      ? await (dependencies.readGhToken ?? readGhCliToken)(config)
      : config.token;
  return (dependencies.createTokenOctokit ?? createTokenOctokit)({
    auth: token,
    baseUrl: config.baseUrl,
  });
}

const ghTokenCache = new Map<string, Promise<string>>();

/**
 * Reads the active gh token at most once per executable/host pair in a process.
 * The token is only held by the Octokit instance and this in-memory promise.
 */
export function readGhCliToken(config: GithubGhCliAuthConfig): Promise<string> {
  const key = config.executable + "\u0000" + (config.hostname ?? "");
  const cached = ghTokenCache.get(key);
  if (cached) {
    return cached;
  }

  const pending = executeGhAuthToken(config);
  ghTokenCache.set(key, pending);
  // Drop failed reads so a repaired login can be retried in the same process.
  void pending.catch(() => {
    if (ghTokenCache.get(key) === pending) {
      ghTokenCache.delete(key);
    }
  });
  return pending;
}

/** Creates an Octokit client for a token supplied by the selected auth mode. */
function createTokenOctokit(options: GithubTokenOctokitOptions): OctokitClient {
  return new Octokit({
    auth: options.auth,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
}

/** Creates an installation-scoped Octokit client, including GitHub Enterprise URLs. */
async function createInstallationOctokit(
  options: GithubInstallationOctokitOptions,
): Promise<OctokitClient> {
  if (options.baseUrl) {
    const AppWithBaseUrl = App.defaults({
      Octokit: Octokit.defaults({ baseUrl: options.baseUrl }),
    });
    const app = new AppWithBaseUrl({
      appId: options.appId,
      privateKey: options.privateKey,
    });
    return app.getInstallationOctokit(options.installationId);
  }

  const app = new App({
    appId: options.appId,
    privateKey: options.privateKey,
  });
  return app.getInstallationOctokit(options.installationId);
}

/** Reads a GitHub CLI token without exposing it to callers other than Octokit setup. */
function executeGhAuthToken(config: GithubGhCliAuthConfig): Promise<string> {
  const args = ["auth", "token"];
  if (config.hostname) {
    args.push("--hostname", config.hostname);
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(config.executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let finished = false;

    const fail = () => {
      if (finished) {
        return;
      }
      finished = true;
      reject(
        new Error(
          "GitHub authentication requires a successful `gh auth login`; could not read the active token.",
        ),
      );
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.once("error", fail);
    child.once("close", (code) => {
      const token = Buffer.concat(stdout).toString("utf8").trim();
      if (code === 0 && token) {
        if (!finished) {
          finished = true;
          resolve(token);
        }
        return;
      }
      fail();
    });
  });
}

/** Returns a non-empty trimmed environment setting, if present. */
function optionalEnvironment(
  environment: GithubEnvironment,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

/** Requires a non-empty runtime environment setting without printing its value. */
function requiredEnvironment(
  environment: GithubEnvironment,
  name: string,
): string {
  const value = environment[name];
  if (!value?.trim()) {
    throw new Error(name + " must be provided at runtime.");
  }
  return value;
}

/** Parses a positive GitHub App installation id from its runtime representation. */
function parseInstallationId(value: string): number {
  const installationId = Number(value);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("GITHUB_APP_INSTALLATION_ID must be a positive integer.");
  }
  return installationId;
}
