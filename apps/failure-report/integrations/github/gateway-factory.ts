import type { Octokit } from "octokit";

import {
  createAuthenticatedOctokit,
  readGithubAuthConfig,
  type GithubAuthConfig,
  type GithubAuthenticationDependencies,
  type GithubEnvironment,
} from "./github-auth.js";
import { GithubCliIssueGateway } from "./github-cli.js";
import type { GithubIssueGateway } from "./issue-gateway.js";
import { OctokitIssueGateway } from "./octokit-issue-gateway.js";

/** Runtime composition for the Root-owned GitHub Issue gateway. */

/** Resolved transport, authentication, and CLI fallback configuration. */
export type GithubGatewayRuntimeConfig = {
  transport: "octokit" | "gh-cli";
  auth: GithubAuthConfig;
  ghCliExecutable: string;
};

/** Injectable factory seams for authentication and gateway composition tests. */
export type GithubIssueGatewayFactoryDependencies =
  GithubAuthenticationDependencies & {
    createOctokitGateway?: (octokit: Octokit) => GithubIssueGateway;
    createGithubCliGateway?: (executable: string) => GithubIssueGateway;
  };

/**
 * Reads the Root process's GitHub transport configuration from its environment.
 * Octokit is the default; the `gh-cli` transport is intentionally explicit and
 * exists only for local fallback or fixture-capture workflows.
 */
export function readGithubGatewayRuntimeConfig(
  environment: GithubEnvironment = process.env,
): GithubGatewayRuntimeConfig {
  const rawTransport = (
    environment.FAILURE_REPORT_GITHUB_GATEWAY ?? "octokit"
  ).trim();
  if (rawTransport !== "octokit" && rawTransport !== "gh-cli") {
    throw new Error("FAILURE_REPORT_GITHUB_GATEWAY must be octokit or gh-cli.");
  }

  const ghCliExecutable =
    environment.FAILURE_REPORT_GH_EXECUTABLE?.trim() || "gh";

  return {
    transport: rawTransport,
    // The explicit legacy transport authenticates itself through gh, so it
    // should not require otherwise-unused Octokit credential configuration.
    auth:
      rawTransport === "octokit"
        ? readGithubAuthConfig(environment)
        : { kind: "gh-cli", executable: ghCliExecutable },
    ghCliExecutable,
  };
}

/**
 * Creates the configured GitHub Issue gateway.
 * The default path uses an authenticated Octokit client; the CLI gateway is only
 * selected when the runtime configuration explicitly opts into it.
 */
export async function createGithubIssueGateway(
  config: GithubGatewayRuntimeConfig = readGithubGatewayRuntimeConfig(),
  dependencies: GithubIssueGatewayFactoryDependencies = {},
): Promise<GithubIssueGateway> {
  if (config.transport === "gh-cli") {
    return (
      dependencies.createGithubCliGateway ??
      ((executable) => new GithubCliIssueGateway(executable))
    )(config.ghCliExecutable);
  }

  const octokit = await createAuthenticatedOctokit(config.auth, dependencies);
  return (
    dependencies.createOctokitGateway ??
    ((client) => new OctokitIssueGateway(client))
  )(octokit);
}

let defaultGatewayPromise: Promise<GithubIssueGateway> | undefined;

/**
 * Root tools share one lazy gateway per process. This makes the default gh
 * credential read happen once while preserving a single Octokit client for all
 * Root-owned GitHub I/O in that process.
 */
export function getDefaultGithubIssueGateway(): Promise<GithubIssueGateway> {
  if (!defaultGatewayPromise) {
    const pending = createGithubIssueGateway();
    defaultGatewayPromise = pending;
    // A rejected credential lookup must not poison later attempts after an
    // operator repairs local `gh auth login` or runtime credentials.
    void pending.catch(() => {
      if (defaultGatewayPromise === pending) {
        defaultGatewayPromise = undefined;
      }
    });
  }
  return defaultGatewayPromise;
}
