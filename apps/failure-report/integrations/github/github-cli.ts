import { spawn } from "node:child_process";

import type { FailureReport } from "@failure-report/protocol";

import {
  type GithubIssueSnapshot,
  type IssueWorkpadMutation,
  findExistingWorkpad,
  prepareIssueWorkpadMutation,
  upsertIssueNarrative,
} from "./issue-workpad.js";

/**
 * GitHub CLI implementation of the durable Issue/workpad gateway.
 *
 * The gateway re-reads state around writes so a report cannot silently overwrite
 * a human edit or another Root process's newer workpad revision.
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

/** Result of a successful narrative/workpad publication. */
export type PublishedSharedContext = {
  issue: GithubIssueSnapshot;
  report: FailureReport;
  workpad_comment_ref: string;
  workpad_revision: number;
};

/**
 * Reads and publishes FailureReport context using `gh api`.
 * The executable is injectable so tests and local wrappers can provide a shim.
 */
export class GithubCliIssueGateway {
  constructor(private readonly executable = "gh") {}

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

  /**
   * Publishes the human narrative and structured workpad with optimistic checks.
   * The narrative write can advance `updated_at`, so the mutation is rebuilt after
   * it before the comment mutation is asserted fresh and sent.
   */
  async publishSharedContext(
    repository: string,
    issueNumber: number,
    report: FailureReport,
    syncedAt: string,
  ): Promise<PublishedSharedContext> {
    let issue = await this.readIssue(repository, issueNumber);
    // Reject a stale report before it can modify either the Issue narrative or workpad.
    let mutation = prepareIssueWorkpadMutation(issue, report, syncedAt);
    const nextBody = upsertIssueNarrative(issue.body, mutation.report);
    if (nextBody !== issue.body) {
      await this.writeIssueBody(repository, issueNumber, nextBody);
      // Refresh after a body write because GitHub updates `updated_at`, which is
      // part of the optimistic-concurrency contract for the workpad mutation.
      issue = await this.readIssue(repository, issueNumber);
      mutation = prepareIssueWorkpadMutation(issue, report, syncedAt);
    }

    const latest = await this.readIssue(repository, issueNumber);
    assertFreshWorkpadMutation(latest, mutation);
    const commentRef = await this.writeWorkpad(
      repository,
      issueNumber,
      mutation,
    );

    return {
      issue,
      report: mutation.report,
      workpad_comment_ref: commentRef,
      workpad_revision: mutation.report.shared_context?.workpad_revision ?? 0,
    };
  }

  /** Updates only the Issue body through GitHub's REST endpoint. */
  private async writeIssueBody(
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

  /** Creates or replaces the one structured workpad comment. */
  private async writeWorkpad(
    repository: string,
    issueNumber: number,
    mutation: IssueWorkpadMutation,
  ): Promise<string> {
    if (mutation.mode === "create") {
      const created = await this.apiJson<GithubIssueCommentResponse>(
        [
          "api",
          "--method",
          "POST",
          "repos/" +
            repository +
            "/issues/" +
            String(issueNumber) +
            "/comments",
          "--input",
          "-",
        ],
        JSON.stringify({ body: mutation.workpad_comment_body }),
      );
      return String(created.id);
    }

    const commentRef = mutation.workpad_comment_ref;
    if (!commentRef) {
      throw new Error("Missing workpad comment reference for an update.");
    }
    const updated = await this.apiJson<GithubIssueCommentResponse>(
      [
        "api",
        "--method",
        "PATCH",
        "repos/" + repository + "/issues/comments/" + commentRef,
        "--input",
        "-",
      ],
      JSON.stringify({ body: mutation.workpad_comment_body }),
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

/** Verifies that the Issue and workpad revision still match the prepared mutation. */
function assertFreshWorkpadMutation(
  issue: GithubIssueSnapshot,
  mutation: IssueWorkpadMutation,
): void {
  if (issue.updated_at !== mutation.expected_issue_updated_at) {
    throw new Error(
      "GitHub Issue changed while preparing the FailureReport workpad.",
    );
  }
  const current = findExistingWorkpad(issue);
  const revision = current?.revision ?? null;
  if (revision !== mutation.expected_workpad_revision) {
    throw new Error(
      "FailureReport workpad changed while preparing the update.",
    );
  }
}
