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
import {
  type WorkpadProducer,
  type WorkpadProducerConfiguration,
  WorkpadNeedsInputError,
  validateProducerConfiguration,
} from "./issue-workpad.js";
import { OctokitIssueGateway } from "./octokit-issue-gateway.js";

/** Runtime composition for the Root-owned GitHub Issue gateway. */

/** Resolved transport, authentication, and CLI fallback configuration. */
export type GithubGatewayRuntimeConfig = {
  transport: "octokit" | "gh-cli";
  auth: GithubAuthConfig;
  ghCliExecutable: string;
  workpadProducers?: WorkpadProducerConfiguration;
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
    workpadProducers: readWorkpadProducerConfiguration(environment),
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
      ((executable) =>
        new GithubCliIssueGateway(executable, config.workpadProducers))
    )(config.ghCliExecutable);
  }

  const octokit = await createAuthenticatedOctokit(config.auth, dependencies);
  return (
    dependencies.createOctokitGateway ??
    ((client) => new OctokitIssueGateway(client, config.workpadProducers))
  )(octokit);
}

/**
 * Reads the explicit producer registry used to authenticate managed comments.
 * Omitting all producer variables leaves the runtime readable but makes reentry
 * and publication fail closed with `needs_input`; a partial configuration fails
 * immediately so a mutable identity can never be inferred from a login name.
 */
export function readWorkpadProducerConfiguration(
  environment: GithubEnvironment = process.env,
): WorkpadProducerConfiguration | undefined {
  const currentId = optionalEnvironment(
    environment,
    "FAILURE_REPORT_GITHUB_WORKPAD_PRODUCER_ID",
  );
  const currentActorId = optionalEnvironment(
    environment,
    "FAILURE_REPORT_GITHUB_WORKPAD_PRODUCER_ACTOR_ID",
  );
  const serializedRegistry = optionalEnvironment(
    environment,
    "FAILURE_REPORT_GITHUB_WORKPAD_PRODUCERS",
  );
  if (!currentId && !currentActorId && !serializedRegistry) {
    return undefined;
  }
  if (!currentId || !currentActorId) {
    throw new WorkpadNeedsInputError(
      "FAILURE_REPORT_GITHUB_WORKPAD_PRODUCER_ID and FAILURE_REPORT_GITHUB_WORKPAD_PRODUCER_ACTOR_ID must be configured together.",
    );
  }

  const producers: WorkpadProducer[] = serializedRegistry
    ? parseWorkpadProducerRegistry(serializedRegistry)
    : [];
  if (!producers.some((producer) => producer.id === currentId)) {
    producers.push({ id: currentId, github_actor_id: currentActorId });
  }
  return validateProducerConfiguration({
    current: { id: currentId, github_actor_id: currentActorId },
    producers,
  });
}

function parseWorkpadProducerRegistry(value: string): WorkpadProducer[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new WorkpadNeedsInputError(
      "FAILURE_REPORT_GITHUB_WORKPAD_PRODUCERS must be a JSON object mapping producer IDs to immutable GitHub actor IDs.",
    );
  }
  if (!decoded || Array.isArray(decoded) || typeof decoded !== "object") {
    throw new WorkpadNeedsInputError(
      "FAILURE_REPORT_GITHUB_WORKPAD_PRODUCERS must be a JSON object mapping producer IDs to immutable GitHub actor IDs.",
    );
  }
  return Object.entries(decoded).map(([id, actorId]) => {
    if (typeof actorId !== "string") {
      throw new WorkpadNeedsInputError(
        "FAILURE_REPORT_GITHUB_WORKPAD_PRODUCERS values must be immutable GitHub actor ID strings.",
      );
    }
    return { id, github_actor_id: actorId };
  });
}

function optionalEnvironment(
  environment: GithubEnvironment,
  key: string,
): string | undefined {
  const value = environment[key]?.trim();
  return value || undefined;
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
