/**
 * Deployment-owned configuration for the optional GitHub Issue Channel.
 *
 * This policy intentionally lives outside Root request data. A repository,
 * organization, or team can only be selected by deployment configuration.
 */

/** Read-only environment shape so channel configuration can be tested safely. */
export type GithubChannelEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** One repository's allowed organization team set. */
export type GithubIssueChannelRepositoryPolicy = {
  readonly organization: string;
  readonly repository: string;
  readonly team_slugs: readonly string[];
};

/** Validated repository-to-organization/team authorization policy. */
export type GithubIssueChannelPolicy = {
  readonly repositories: readonly GithubIssueChannelRepositoryPolicy[];
};

/** Runtime-only options for the optional GitHub Issue Channel. */
export type GithubIssueChannelRuntimeConfig = {
  readonly botName: string;
  readonly policy: GithubIssueChannelPolicy;
  readonly progressReactions: boolean;
};

const POLICY_ENVIRONMENT_VARIABLE = "FAILURE_REPORT_GITHUB_CHANNEL_POLICY";
const BOT_NAME_ENVIRONMENT_VARIABLE = "FAILURE_REPORT_GITHUB_CHANNEL_BOT_NAME";
const PROGRESS_REACTIONS_ENVIRONMENT_VARIABLE =
  "FAILURE_REPORT_GITHUB_CHANNEL_PROGRESS_REACTIONS";
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const GITHUB_ORGANIZATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;
const GITHUB_TEAM_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

/**
 * Reads the optional channel configuration. Without an explicit policy the
 * channel is disabled entirely, preserving deployments that only use HTTP.
 */
export function readGithubIssueChannelRuntimeConfig(
  environment: GithubChannelEnvironment = process.env,
): GithubIssueChannelRuntimeConfig | undefined {
  const serializedPolicy = optionalEnvironment(
    environment,
    POLICY_ENVIRONMENT_VARIABLE,
  );
  if (!serializedPolicy) {
    return undefined;
  }

  const botName =
    optionalEnvironment(environment, BOT_NAME_ENVIRONMENT_VARIABLE) ??
    optionalEnvironment(environment, "GITHUB_APP_SLUG");
  if (!botName || !GITHUB_ORGANIZATION_PATTERN.test(botName)) {
    throw new Error(
      "GitHub Issue Channel requires FAILURE_REPORT_GITHUB_CHANNEL_BOT_NAME or GITHUB_APP_SLUG.",
    );
  }

  return {
    botName,
    policy: parseGithubIssueChannelPolicy(serializedPolicy),
    progressReactions: readProgressReactions(environment),
  };
}

/** Parses the JSON deployment policy and rejects every ambiguous form. */
export function parseGithubIssueChannelPolicy(
  serializedPolicy: string,
): GithubIssueChannelPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedPolicy) as unknown;
  } catch {
    throw new Error("GitHub Issue Channel policy must be valid JSON.");
  }

  if (!isRecord(parsed)) {
    throw new Error("GitHub Issue Channel policy must be an object.");
  }
  assertOnlyKeys(parsed, ["repositories"]);
  if (!Array.isArray(parsed.repositories) || parsed.repositories.length === 0) {
    throw new Error(
      "GitHub Issue Channel policy must configure at least one repository.",
    );
  }

  const repositories = parsed.repositories.map(parseRepositoryPolicy);
  const configuredRepositories = new Set<string>();
  for (const repository of repositories) {
    const normalized = normalizeRepository(repository.repository);
    if (configuredRepositories.has(normalized)) {
      throw new Error(
        "GitHub Issue Channel policy contains duplicate repository entries.",
      );
    }
    configuredRepositories.add(normalized);
  }

  return { repositories };
}

/** Returns the sole policy selected by a webhook repository, if configured. */
export function findGithubIssueChannelRepositoryPolicy(
  policy: GithubIssueChannelPolicy,
  repository: string,
): GithubIssueChannelRepositoryPolicy | undefined {
  const normalized = tryNormalizeRepository(repository);
  if (!normalized) {
    return undefined;
  }
  return policy.repositories.find(
    (candidate) => normalizeRepository(candidate.repository) === normalized,
  );
}

function parseRepositoryPolicy(
  candidate: unknown,
): GithubIssueChannelRepositoryPolicy {
  if (!isRecord(candidate)) {
    throw new Error(
      "GitHub Issue Channel repository policies must be objects.",
    );
  }
  assertOnlyKeys(candidate, ["repository", "organization", "team_slugs"]);

  const repository = requiredString(candidate.repository);
  const organization = requiredString(candidate.organization);
  const [owner] = parseRepository(repository);
  if (
    !GITHUB_ORGANIZATION_PATTERN.test(organization) ||
    owner.toLowerCase() !== organization.toLowerCase()
  ) {
    throw new Error(
      "GitHub Issue Channel repository organization must match its configured organization.",
    );
  }

  if (
    !Array.isArray(candidate.team_slugs) ||
    candidate.team_slugs.length === 0
  ) {
    throw new Error(
      "GitHub Issue Channel repository policies require at least one team slug.",
    );
  }
  const teamSlugs = candidate.team_slugs.map((teamSlug) => {
    const value = requiredString(teamSlug);
    if (!GITHUB_TEAM_SLUG_PATTERN.test(value)) {
      throw new Error(
        "GitHub Issue Channel team slugs must use lowercase GitHub slug syntax.",
      );
    }
    return value;
  });
  if (new Set(teamSlugs).size !== teamSlugs.length) {
    throw new Error(
      "GitHub Issue Channel repository policies must not repeat team slugs.",
    );
  }

  return {
    organization,
    repository,
    team_slugs: teamSlugs,
  };
}

function readProgressReactions(environment: GithubChannelEnvironment): boolean {
  const configured = optionalEnvironment(
    environment,
    PROGRESS_REACTIONS_ENVIRONMENT_VARIABLE,
  );
  if (configured === undefined) {
    return true;
  }
  if (configured === "true") {
    return true;
  }
  if (configured === "false") {
    return false;
  }
  throw new Error(
    "FAILURE_REPORT_GITHUB_CHANNEL_PROGRESS_REACTIONS must be true or false.",
  );
}

function parseRepository(repository: string): [owner: string, name: string] {
  const parts = repository.split("/");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !GITHUB_NAME_PATTERN.test(parts[0]) ||
    !GITHUB_NAME_PATTERN.test(parts[1])
  ) {
    throw new Error(
      "GitHub Issue Channel repositories must use an explicit owner/name value.",
    );
  }
  return [parts[0], parts[1]];
}

function normalizeRepository(repository: string): string {
  const [owner, name] = parseRepository(repository);
  return `${owner}/${name}`.toLowerCase();
}

function tryNormalizeRepository(repository: string): string | undefined {
  try {
    return normalizeRepository(repository);
  } catch {
    return undefined;
  }
}

function requiredString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(
      "GitHub Issue Channel policy contains an invalid string value.",
    );
  }
  return value;
}

function optionalEnvironment(
  environment: GithubChannelEnvironment,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new Error("GitHub Issue Channel policy contains unsupported fields.");
  }
}
