import { spawn } from "node:child_process";

import type { GithubIssueSnapshot } from "./issue-workpad.js";
import { IssueWorkpadGateway } from "./issue-gateway.js";

/**
 * Explicit legacy fallback for fixture capture or local diagnosis.
 *
 * Production composition uses `OctokitIssueGateway`; this class remains useful
 * when `FAILURE_REPORT_GITHUB_GATEWAY=gh-cli` is deliberately selected.
 */

type GithubIssueResponse = {
  body: string | null;
  html_url: string;
  number: number;
  updated_at: string;
};

type GithubIssueCommentResponse = {
  body: string;
  id: number;
  updated_at: string;
};

/**
 * Implements the narrow Issue workpad port through `gh api`.
 *
 * Shared optimistic-concurrency and workpad publication behavior lives in the
 * parent class so the CLI and Octokit transports cannot drift semantically.
 */
export class GithubCliIssueGateway extends IssueWorkpadGateway {
  constructor(private readonly executable = "gh") {
    super();
  }

  /** Reads an Issue and all comments needed to locate its single workpad. */
  async readIssue(
    repository: string,
    issueNumber: number,
  ): Promise<GithubIssueSnapshot> {
    const issue = await this.apiJson<GithubIssueResponse>([
      "api",
      "repos/" + repository + "/issues/" + String(issueNumber),
    ]);
    const comments = await this.apiJsonPages<GithubIssueCommentResponse>([
      "api",
      "--paginate",
      "repos/" +
        repository +
        "/issues/" +
        String(issueNumber) +
        "/comments?per_page=100",
    ]);

    return {
      repository,
      issue_number: issue.number,
      issue_url: issue.html_url,
      body: issue.body ?? "",
      updated_at: issue.updated_at,
      comments: comments.map((comment) => ({
        id: String(comment.id),
        body: comment.body,
        updated_at: comment.updated_at,
      })),
    };
  }

  /** Updates only the Issue body through GitHub's REST endpoint. */
  protected async updateIssueBody(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<void> {
    await this.run(
      [
        "api",
        "--method",
        "PATCH",
        "repos/" + repository + "/issues/" + String(issueNumber),
        "--input",
        "-",
      ],
      JSON.stringify({ body }),
    );
  }

  /** Creates the one structured workpad comment when an Issue has none yet. */
  protected async createWorkpadComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<string> {
    const created = await this.apiJson<GithubIssueCommentResponse>(
      [
        "api",
        "--method",
        "POST",
        "repos/" + repository + "/issues/" + String(issueNumber) + "/comments",
        "--input",
        "-",
      ],
      JSON.stringify({ body }),
    );
    return String(created.id);
  }

  /** Replaces the existing workpad comment without creating historical copies. */
  protected async updateWorkpadComment(
    repository: string,
    commentRef: string,
    body: string,
  ): Promise<string> {
    const updated = await this.apiJson<GithubIssueCommentResponse>(
      [
        "api",
        "--method",
        "PATCH",
        "repos/" + repository + "/issues/comments/" + commentRef,
        "--input",
        "-",
      ],
      JSON.stringify({ body }),
    );
    return String(updated.id);
  }

  /** Executes one JSON-returning GitHub CLI request. */
  private async apiJson<T>(args: string[], input?: string): Promise<T> {
    const stdout = await this.run(args, input);
    return JSON.parse(stdout) as T;
  }

  /**
   * Decodes either a single JSON document or `gh --paginate`'s concatenated pages.
   * GitHub CLI output differs by endpoint/version, so both encodings are accepted.
   */
  private async apiJsonPages<T>(args: string[]): Promise<T[]> {
    const stdout = await this.run(args);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }
    try {
      const decoded: unknown = JSON.parse(trimmed);
      return Array.isArray(decoded) ? (decoded as T[]) : [decoded as T];
    } catch {
      return trimmed.split(/\n(?=[[{])/).flatMap((page) => {
        const decoded: unknown = JSON.parse(page);
        return Array.isArray(decoded) ? (decoded as T[]) : [decoded as T];
      });
    }
  }

  /** Runs `gh` without a shell and returns stdout only after a successful exit. */
  private run(args: string[], input?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.executable, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString("utf8"));
          return;
        }
        reject(
          new Error(
            "gh api failed: " + Buffer.concat(stderr).toString("utf8").trim(),
          ),
        );
      });
      child.stdin.end(input);
    });
  }
}
