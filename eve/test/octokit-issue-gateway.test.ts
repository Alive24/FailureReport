import { readFile } from "node:fs/promises";

import type { Octokit } from "octokit";
import { describe, expect, it, vi } from "vitest";

import {
  failureReportSchema,
  parseFailureReportWorkpad,
} from "@failure-report/protocol";

import {
  type GithubIssueSnapshot,
  type WorkpadProducerConfiguration,
  findExistingWorkpad,
  prepareIssueWorkpadMutation,
} from "../agent/lib/integrations/github/issue-workpad.js";
import { OctokitIssueGateway } from "../agent/lib/integrations/github/octokit-issue-gateway.js";

const repository = "Alive24/CKBoost";
const issueNumber = 54;
const issueTitle = "CKBoost Issue 54";
const issueUrl = "https://github.com/Alive24/CKBoost/issues/54";

const rootGh: WorkpadProducerConfiguration = {
  current: { id: "root-gh", github_actor_id: "101" },
  producers: [
    { id: "root-gh", github_actor_id: "101" },
    { id: "root-app", github_actor_id: "202" },
  ],
};
const rootApp: WorkpadProducerConfiguration = {
  ...rootGh,
  current: { id: "root-app", github_actor_id: "202" },
};

async function loadReport() {
  const file = new URL(
    "../../packages/protocol/test/fixtures/issue-54.json",
    import.meta.url,
  );
  return failureReportSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/** Exercises Octokit mapping, provenance, append behavior, and stale-write rejection. */
describe("Octokit Issue gateway", () => {
  it("maps actual comment author identities through Octokit", async () => {
    const listComments = vi.fn();
    const octokit = {
      rest: {
        users: { getAuthenticated: vi.fn() },
        issues: {
          get: vi.fn().mockResolvedValue({
            data: {
              body: null,
              html_url: issueUrl,
              number: issueNumber,
              title: issueTitle,
              updated_at: "2026-07-15T10:00:00Z",
            },
          }),
          listComments,
          update: vi.fn(),
          createComment: vi.fn(),
          updateComment: vi.fn(),
        },
      },
      paginate: vi.fn().mockResolvedValue([
        {
          id: 10,
          body: "Human context",
          updated_at: "2026-07-15T10:00:01Z",
          user: { id: 777, login: "human", type: "User" },
        },
        {
          id: 11,
          body: null,
          updated_at: "2026-07-15T10:00:02Z",
          user: null,
        },
      ]),
    };
    const gateway = new OctokitIssueGateway(
      octokit as unknown as Octokit,
      rootGh,
    );

    const issue = await gateway.readIssue(repository, issueNumber);

    expect(issue).toEqual({
      repository,
      issue_number: issueNumber,
      title: issueTitle,
      issue_url: issueUrl,
      body: "",
      updated_at: "2026-07-15T10:00:00Z",
      comments: [
        {
          id: "10",
          body: "Human context",
          updated_at: "2026-07-15T10:00:01Z",
          author: { id: "777", login: "human", type: "User" },
        },
        {
          id: "11",
          body: "",
          updated_at: "2026-07-15T10:00:02Z",
          author: null,
        },
      ],
    });
    expect(octokit.paginate).toHaveBeenCalledWith(listComments, {
      owner: "Alive24",
      repo: "CKBoost",
      issue_number: issueNumber,
      per_page: 100,
    });
  });

  it("creates then appends to one same-producer comment without touching Issue bodies", async () => {
    const report = await loadReport();
    const fake = createMutableOctokit();
    const gateway = new OctokitIssueGateway(
      fake.octokit as unknown as Octokit,
      rootGh,
    );

    const first = await gateway.publishSharedContext(
      repository,
      issueNumber,
      report,
      "2026-07-15T10:01:00Z",
    );
    const second = await gateway.publishSharedContext(
      repository,
      issueNumber,
      first.report,
      "2026-07-15T10:02:00Z",
    );

    expect(fake.octokit.rest.issues.update).not.toHaveBeenCalled();
    expect(fake.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(fake.octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    expect(fake.comments).toHaveLength(1);
    expect(
      parseFailureReportWorkpad(fake.comments[0]?.body ?? "").entries.map(
        (entry) => entry.revision,
      ),
    ).toEqual([0, 1]);
    expect(first.workpad_comment_ref).toBe("101");
    expect(second.workpad_comment_ref).toBe("101");
    expect(second.workpad_revision).toBe(1);
  });

  it("creates a linked successor when a different configured producer continues", async () => {
    const report = await loadReport();
    const fake = createMutableOctokit();
    const firstGateway = new OctokitIssueGateway(
      fake.octokit as unknown as Octokit,
      rootGh,
    );
    const first = await firstGateway.publishSharedContext(
      repository,
      issueNumber,
      report,
      "2026-07-15T10:01:00Z",
    );
    fake.setAuthenticatedActor("202");
    const continuationGateway = new OctokitIssueGateway(
      fake.octokit as unknown as Octokit,
      rootApp,
    );
    const continued = await continuationGateway.publishSharedContext(
      repository,
      issueNumber,
      first.report,
      "2026-07-15T10:02:00Z",
    );

    expect(fake.octokit.rest.issues.update).not.toHaveBeenCalled();
    expect(fake.octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
    expect(fake.octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(fake.comments.map((comment) => comment.user.id)).toEqual([101, 202]);
    const latest = findExistingWorkpad(
      await continuationGateway.readIssue(repository, issueNumber),
      rootApp,
    );
    expect(latest?.comment.id).toBe(continued.workpad_comment_ref);
    expect(latest?.predecessor_comment_ref).toBe(first.workpad_comment_ref);
  });

  it("rejects an authenticated actor mismatch before it writes any comment", async () => {
    const report = await loadReport();
    const fake = createMutableOctokit();
    fake.setAuthenticatedActor("999");
    const gateway = new OctokitIssueGateway(
      fake.octokit as unknown as Octokit,
      rootGh,
    );

    await expect(
      gateway.publishSharedContext(
        repository,
        issueNumber,
        report,
        "2026-07-15T10:01:00Z",
      ),
    ).rejects.toThrow("does not match the authenticated GitHub actor");
    expect(fake.octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(fake.octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("rejects an Issue timestamp conflict before it writes a comment", async () => {
    const report = await loadReport();
    const initial = snapshot({ updated_at: "2026-07-15T10:00:00Z" });
    const changed = { ...initial, updated_at: "2026-07-15T10:00:01Z" };
    const fake = createScriptedOctokit([initial, changed]);
    const gateway = new OctokitIssueGateway(fake as unknown as Octokit, rootGh);

    await expect(
      gateway.publishSharedContext(
        repository,
        issueNumber,
        report,
        "2026-07-15T10:01:00Z",
      ),
    ).rejects.toThrow("GitHub Issue changed");
    expect(fake.rest.issues.createComment).not.toHaveBeenCalled();
    expect(fake.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("rejects a changed verified workpad revision before an append", async () => {
    const report = await loadReport();
    const first = prepareIssueWorkpadMutation(
      snapshot(),
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
    );
    const initial = snapshot({
      comments: [
        {
          id: "101",
          body: first.workpad_comment_body,
          updated_at: "2026-07-15T10:01:00Z",
          author: { id: "101" },
        },
      ],
    });
    const later = prepareIssueWorkpadMutation(
      initial,
      first.report,
      "2026-07-15T10:02:00Z",
      rootGh,
    );
    const changed = {
      ...initial,
      comments: [
        {
          id: "101",
          body: later.workpad_comment_body,
          updated_at: "2026-07-15T10:02:00Z",
          author: { id: "101" },
        },
      ],
    };
    const fake = createScriptedOctokit([initial, changed]);
    const gateway = new OctokitIssueGateway(fake as unknown as Octokit, rootGh);

    await expect(
      gateway.publishSharedContext(
        repository,
        issueNumber,
        first.report,
        "2026-07-15T10:03:00Z",
      ),
    ).rejects.toThrow("workpad changed");
    expect(fake.rest.issues.updateComment).not.toHaveBeenCalled();
  });
});

function snapshot(
  overrides: Partial<GithubIssueSnapshot> = {},
): GithubIssueSnapshot {
  return {
    repository,
    issue_number: issueNumber,
    title: issueTitle,
    issue_url: issueUrl,
    body: "# Existing human Issue body",
    updated_at: "2026-07-15T10:00:00Z",
    comments: [],
    ...overrides,
  };
}

function createMutableOctokit() {
  let body = "# Existing human Issue body";
  let updatedAt = "2026-07-15T10:00:00Z";
  let authenticatedActorId = "101";
  let nextCommentId = 101;
  const comments: Array<{
    id: number;
    body: string;
    updated_at: string;
    user: { id: number; login: string; type: string };
  }> = [];

  const octokit = {
    rest: {
      users: {
        getAuthenticated: vi.fn(async () => ({
          data: {
            id: Number(authenticatedActorId),
            login: "fixture-" + authenticatedActorId,
            type: "User",
          },
        })),
      },
      issues: {
        get: vi.fn(async () => ({
          data: {
            body,
            html_url: issueUrl,
            number: issueNumber,
            title: issueTitle,
            updated_at: updatedAt,
          },
        })),
        listComments: vi.fn(),
        update: vi.fn(),
        createComment: vi.fn(
          async ({ body: commentBody }: { body: string }) => {
            const comment = {
              id: nextCommentId,
              body: commentBody,
              updated_at: "2026-07-15T10:00:02Z",
              user: {
                id: Number(authenticatedActorId),
                login: "fixture-" + authenticatedActorId,
                type: "User",
              },
            };
            nextCommentId += 1;
            comments.push(comment);
            updatedAt = comment.updated_at;
            return { data: comment };
          },
        ),
        updateComment: vi.fn(
          async ({
            body: commentBody,
            comment_id: commentId,
          }: {
            body: string;
            comment_id: number;
          }) => {
            const comment = comments.find((item) => item.id === commentId);
            if (!comment) {
              throw new Error("Comment not found.");
            }
            comment.body = commentBody;
            comment.updated_at = "2026-07-15T10:00:03Z";
            updatedAt = comment.updated_at;
            return { data: comment };
          },
        ),
      },
    },
    paginate: vi.fn(async () => comments.map((comment) => ({ ...comment }))),
  };

  return {
    octokit,
    comments,
    setAuthenticatedActor(actorId: string) {
      authenticatedActorId = actorId;
    },
  };
}

function createScriptedOctokit(snapshots: GithubIssueSnapshot[]) {
  let current = snapshots[0];
  let readIndex = 0;

  return {
    rest: {
      users: {
        getAuthenticated: vi.fn().mockResolvedValue({
          data: { id: 101, login: "fixture-101", type: "User" },
        }),
      },
      issues: {
        get: vi.fn(async () => {
          current = snapshots[Math.min(readIndex, snapshots.length - 1)];
          readIndex += 1;
          if (!current) {
            throw new Error("Missing scripted Issue snapshot.");
          }
          return {
            data: {
              body: current.body,
              html_url: current.issue_url,
              number: current.issue_number,
              title: current.title,
              updated_at: current.updated_at,
            },
          };
        }),
        listComments: vi.fn(),
        update: vi.fn(),
        createComment: vi.fn(),
        updateComment: vi.fn(),
      },
    },
    paginate: vi.fn(async () =>
      (current?.comments ?? []).map((comment) => ({
        id: Number(comment.id),
        body: comment.body,
        updated_at: comment.updated_at,
        user: comment.author
          ? {
              id: Number(comment.author.id),
              login: comment.author.login ?? "fixture",
              type: comment.author.type ?? "User",
            }
          : null,
      })),
    ),
  };
}
