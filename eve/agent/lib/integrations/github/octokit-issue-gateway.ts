import type { Octokit } from "octokit";

import type {
  GithubActorIdentity,
  GithubIssueSnapshot,
  WorkpadProducerConfiguration,
} from "./issue-workpad.js";
import { IssueWorkpadGateway } from "./issue-gateway.js";

/**
 * Octokit transport for the Root-owned GitHub Issue workpad port.
 *
 * Authentication is deliberately supplied by the factory so this class is only
 * responsible for repository parsing and SDK request/response mapping.
 */

/**
 * Octokit-backed GitHub Issue integration. All Issue and comment API calls use
 * the SDK; the caller decides how the Octokit client is authenticated.
 */
export class OctokitIssueGateway extends IssueWorkpadGateway {
  constructor(
    private readonly octokit: Octokit,
    producers?: WorkpadProducerConfiguration,
  ) {
    super(producers);
  }

  /** Reads the Issue body and paginates all comments before constructing a snapshot. */
  async readIssue(
    repository: string,
    issueNumber: number,
  ): Promise<GithubIssueSnapshot> {
    const { owner, repo } = splitRepository(repository);
    const issue = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });
    const comments = await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      },
    );

    return {
      repository,
      issue_number: issue.data.number,
      issue_url: issue.data.html_url,
      body: issue.data.body ?? "",
      updated_at: issue.data.updated_at,
      comments: comments.map((comment) => ({
        id: String(comment.id),
        body: comment.body ?? "",
        updated_at: comment.updated_at,
        author: githubActorIdentity(comment.user),
      })),
    };
  }

  /** Reads the active credential's immutable GitHub account identifier. */
  protected async readAuthenticatedActor(): Promise<GithubActorIdentity> {
    const authenticated = await this.octokit.rest.users.getAuthenticated();
    const actor = githubActorIdentity(authenticated.data);
    if (!actor) {
      throw new Error(
        "GitHub authenticated actor response has no immutable id.",
      );
    }
    return actor;
  }

  /** Creates the one marked workpad comment for an Issue's first publication. */
  protected async createWorkpadComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<string> {
    const { owner, repo } = splitRepository(repository);
    const created = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return String(created.data.id);
  }

  /** Replaces the existing marked workpad comment on a later revision. */
  protected async updateWorkpadComment(
    repository: string,
    commentRef: string,
    body: string,
  ): Promise<string> {
    const { owner, repo } = splitRepository(repository);
    const updated = await this.octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: Number(commentRef),
      body,
    });
    return String(updated.data.id);
  }
}

/** Maps GitHub's live user/App object without treating its login as identity. */
function githubActorIdentity(
  user:
    | {
        id?: number | string | null;
        login?: string | null;
        type?: string | null;
      }
    | null
    | undefined,
): GithubActorIdentity | null {
  if (user?.id === null || user?.id === undefined) {
    return null;
  }
  return {
    id: String(user.id),
    ...(user.login ? { login: user.login } : {}),
    ...(user.type ? { type: user.type } : {}),
  };
}

/** Splits and validates the `owner/repository` identifier required by Octokit. */
function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra || owner.includes(" ") || repo.includes(" ")) {
    throw new Error("GitHub repository must use the owner/repository form.");
  }
  return { owner, repo };
}
