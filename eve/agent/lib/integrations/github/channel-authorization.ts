import { GitHubApiError } from "eve/channels/github";

import {
  type GithubIssueChannelPolicy,
  findGithubIssueChannelRepositoryPolicy,
} from "./channel-policy.js";

/** Installation-scoped subset of Eve's native GitHub client used for membership. */
export interface GithubInstallationMembershipClient {
  request<T = unknown>(input: {
    readonly method: "GET";
    readonly path: string;
  }): Promise<{ readonly body: T }>;
}

/** Sanitized authorization outcome; raw GitHub responses never leave this seam. */
export type GithubIssueChannelAuthorization =
  | { readonly authorized: true }
  | {
      readonly authorized: false;
      readonly reason:
        | "inactive_membership"
        | "membership_lookup_failed"
        | "unconfigured_repository";
    };

/**
 * Checks every configured team using the inbound webhook's installation client.
 * A request error (including missing Members: read) denies the entire comment;
 * this intentionally does not cache membership between deliveries.
 */
export async function authorizeGithubIssueChannelActor(input: {
  readonly client: GithubInstallationMembershipClient;
  readonly policy: GithubIssueChannelPolicy;
  readonly repository: string;
  readonly senderLogin: string;
}): Promise<GithubIssueChannelAuthorization> {
  const repositoryPolicy = findGithubIssueChannelRepositoryPolicy(
    input.policy,
    input.repository,
  );
  if (!repositoryPolicy || !isGithubLogin(input.senderLogin)) {
    return { authorized: false, reason: "unconfigured_repository" };
  }

  const outcomes = await Promise.all(
    repositoryPolicy.team_slugs.map((teamSlug) =>
      readMembershipState({
        client: input.client,
        organization: repositoryPolicy.organization,
        senderLogin: input.senderLogin,
        teamSlug,
      }),
    ),
  );
  if (outcomes.some((outcome) => outcome === "error")) {
    return { authorized: false, reason: "membership_lookup_failed" };
  }
  if (outcomes.some((outcome) => outcome === "active")) {
    return { authorized: true };
  }
  return { authorized: false, reason: "inactive_membership" };
}

async function readMembershipState(input: {
  readonly client: GithubInstallationMembershipClient;
  readonly organization: string;
  readonly senderLogin: string;
  readonly teamSlug: string;
}): Promise<"active" | "inactive" | "error"> {
  try {
    const response = await input.client.request<{ state?: unknown }>({
      method: "GET",
      path: `/orgs/${encodeURIComponent(input.organization)}/teams/${encodeURIComponent(input.teamSlug)}/memberships/${encodeURIComponent(input.senderLogin)}`,
    });
    return response.body?.state === "active" ? "active" : "inactive";
  } catch (error) {
    // GitHub uses 404 for an absent team membership. Other failures, especially
    // 403 permission failures, must remain indistinguishable to the commenter.
    return isAbsentMembership(error) ? "inactive" : "error";
  }
}

function isAbsentMembership(error: unknown): boolean {
  return (
    (error instanceof GitHubApiError && error.status === 404) ||
    (typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 404)
  );
}

function isGithubLogin(value: string): boolean {
  return value.trim().length > 0 && !value.includes("/");
}
