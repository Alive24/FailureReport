import { readFile } from "node:fs/promises";

import type { Octokit } from "octokit";
import { describe, expect, it, vi } from "vitest";

import {
  failureReportSchema,
  parseFailureReportWorkpad,
} from "@failure-report/protocol";

import {
  type GithubIssueSnapshot,
  prepareIssueWorkpadMutation,
  upsertIssueNarrative,
} from "../agent/lib/integrations/github/issue-workpad.js";
import { OctokitIssueGateway } from "../agent/lib/integrations/github/octokit-issue-gateway.js";

/** Stable target Issue identity used by the in-memory Octokit scenarios. */
const repository = "Alive24/CKBoost";
const issueNumber = 54;
const issueUrl = "https://github.com/Alive24/CKBoost/issues/54";

/** Loads a schema-validated report fixture for gateway publication tests. */
async function loadReport() {
  const file = new URL(
    "../../packages/protocol/test/fixtures/issue-54.json",
    import.meta.url,
  );
  return failureReportSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/** Exercises Octokit mapping, workpad persistence, and stale-write rejection. */
describe("Octokit Issue gateway", () => {
  it("maps an Issue snapshot and paginates all comments through Octokit", async () => {
    const listComments = vi.fn();
    const octokit = {
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({
            data: {
              body: null,
              html_url: issueUrl,
              number: issueNumber,
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
        },
        {
          id: 11,
          body: null,
          updated_at: "2026-07-15T10:00:02Z",
        },
      ]),
    };
    const gateway = new OctokitIssueGateway(octokit as unknown as Octokit);

    const issue = await gateway.readIssue(repository, issueNumber);

    expect(issue).toEqual({
      repository,
      issue_number: issueNumber,
      issue_url: issueUrl,
      body: "",
      updated_at: "2026-07-15T10:00:00Z",
      comments: [
        {
          id: "10",
          body: "Human context",
          updated_at: "2026-07-15T10:00:01Z",
        },
        {
          id: "11",
          body: "",
          updated_at: "2026-07-15T10:00:02Z",
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

  it("creates one workpad comment then updates that same comment on resume", async () => {
    const report = await loadReport();
    const fake = createMutableOctokit();
    const gateway = new OctokitIssueGateway(fake.octokit as unknown as Octokit);

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

    expect(fake.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(fake.octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]?.id).toBe(101);
    expect(
      parseFailureReportWorkpad(fake.comments[0]?.body ?? "").revision,
    ).toBe(1);
    expect(first.workpad_comment_ref).toBe("101");
    expect(second.workpad_comment_ref).toBe("101");
    expect(second.workpad_revision).toBe(1);
  });

  it("rejects an Issue timestamp conflict before it creates a workpad comment", async () => {
    const report = await loadReport();
    const initial = snapshot({
      body: upsertIssueNarrative("# Existing Issue", report),
      updated_at: "2026-07-15T10:00:00Z",
    });
    const changed = { ...initial, updated_at: "2026-07-15T10:00:01Z" };
    const fake = createScriptedOctokit([initial, changed]);
    const gateway = new OctokitIssueGateway(fake as unknown as Octokit);

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

  it("rejects a changed workpad revision before it updates the comment", async () => {
    const report = await loadReport();
    const empty = snapshot({
      body: "# Existing Issue",
      updated_at: "2026-07-15T10:00:00Z",
    });
    const first = prepareIssueWorkpadMutation(
      empty,
      report,
      "2026-07-15T10:01:00Z",
    );
    const initial = {
      ...empty,
      body: upsertIssueNarrative(empty.body, first.report),
      comments: [
        {
          id: "101",
          body: first.workpad_comment_body,
          updated_at: "2026-07-15T10:01:00Z",
        },
      ],
    };
    const later = prepareIssueWorkpadMutation(
      initial,
      first.report,
      "2026-07-15T10:02:00Z",
    );
    const changed = {
      ...initial,
      comments: [
        {
          id: "101",
          body: later.workpad_comment_body,
          updated_at: "2026-07-15T10:02:00Z",
        },
      ],
    };
    const fake = createScriptedOctokit([initial, changed]);
    const gateway = new OctokitIssueGateway(fake as unknown as Octokit);

    await expect(
      gateway.publishSharedContext(
        repository,
        issueNumber,
        first.report,
        "2026-07-15T10:03:00Z",
      ),
    ).rejects.toThrow("FailureReport workpad changed");
    expect(fake.rest.issues.updateComment).not.toHaveBeenCalled();
  });
});

/** Builds a default Issue snapshot and overlays only fields relevant to one scenario. */
function snapshot(
  overrides: Partial<GithubIssueSnapshot> = {},
): GithubIssueSnapshot {
  return {
    repository,
    issue_number: issueNumber,
    issue_url: issueUrl,
    body: "# Existing Issue",
    updated_at: "2026-07-15T10:00:00Z",
    comments: [],
    ...overrides,
  };
}

/**
 * Creates a stateful Octokit fake whose Issue body and one workpad comment mutate
 * exactly as a successful create/update publication would.
 */
function createMutableOctokit() {
  let body = "# Existing Issue";
  let updatedAt = "2026-07-15T10:00:00Z";
  const comments: Array<{ id: number; body: string; updated_at: string }> = [];

  const octokit = {
    rest: {
      issues: {
        get: vi.fn(async () => ({
          data: {
            body,
            html_url: issueUrl,
            number: issueNumber,
            updated_at: updatedAt,
          },
        })),
        listComments: vi.fn(),
        update: vi.fn(async ({ body: nextBody }: { body: string }) => {
          body = nextBody;
          updatedAt = "2026-07-15T10:00:01Z";
          return { data: {} };
        }),
        createComment: vi.fn(
          async ({ body: commentBody }: { body: string }) => {
            const comment = {
              id: 101,
              body: commentBody,
              updated_at: "2026-07-15T10:00:02Z",
            };
            comments.push(comment);
            updatedAt = "2026-07-15T10:00:02Z";
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
            updatedAt = "2026-07-15T10:00:03Z";
            return { data: comment };
          },
        ),
      },
    },
    paginate: vi.fn(async () => comments.map((comment) => ({ ...comment }))),
  };

  return { octokit, comments };
}

/**
 * Creates an Octokit fake that serves successive snapshots on reads to model a
 * concurrent writer changing the Issue between publication freshness checks.
 */
function createScriptedOctokit(snapshots: GithubIssueSnapshot[]) {
  let current = snapshots[0];
  let readIndex = 0;

  return {
    rest: {
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
      })),
    ),
  };
}
