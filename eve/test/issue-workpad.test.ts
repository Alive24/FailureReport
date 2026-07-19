import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  failureReportSchema,
  parseFailureReportWorkpad,
  workpadMarker,
} from "@failure-report/protocol";

import {
  WorkpadNeedsInputError,
  findExistingWorkpad,
  prepareIssueWorkpadMutation,
  type GithubIssueComment,
  type GithubIssueSnapshot,
  type WorkpadProducerConfiguration,
} from "../agent/lib/integrations/github/issue-workpad.js";

/** Loads a schema-validated report fixture instead of exposing raw JSON to tests. */
async function loadReport() {
  const file = new URL(
    "../../packages/protocol/test/fixtures/issue-54.json",
    import.meta.url,
  );
  return failureReportSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

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

/** Minimal target Issue used to test pure managed-comment transformations. */
function issue(comments: GithubIssueComment[] = []): GithubIssueSnapshot {
  return {
    repository: "Alive24/CKBoost",
    issue_number: 54,
    issue_url: "https://github.com/Alive24/CKBoost/issues/54",
    body: "# Human-authored Issue context\n\nDo not erase.",
    updated_at: "2026-07-15T10:00:00Z",
    comments,
  };
}

function managedComment(
  id: string,
  body: string,
  actorId: string,
): GithubIssueComment {
  return {
    id,
    body,
    updated_at: "2026-07-15T10:01:00Z",
    author: { id: actorId, login: "fixture-" + actorId },
  };
}

/** Covers provenance, append-only behavior, continuations, and fail-closed reentry. */
describe("GitHub Issue workpad", () => {
  it("creates the first provenance-bound workpad without changing the Issue body", async () => {
    const report = await loadReport();
    const target = issue();
    const mutation = prepareIssueWorkpadMutation(
      target,
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
    );
    const parsed = parseFailureReportWorkpad(mutation.workpad_comment_body);

    expect(mutation.mode).toBe("create");
    expect(mutation.expected_workpad_revision).toBeNull();
    expect(target.body).toBe("# Human-authored Issue context\n\nDo not erase.");
    expect(parsed.entries[0]?.producer).toEqual(rootGh.current);
    expect(parsed.entries[0]?.logical_session_id).toContain(
      "Alive24/CKBoost/54",
    );
    expect(parsed.entries[0]?.report.shared_context?.workpad_revision).toBe(0);
  });

  it("appends same-producer history in the verified comment without rewriting prior bytes", async () => {
    const report = await loadReport();
    const first = prepareIssueWorkpadMutation(
      issue(),
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
    );
    const firstComment = managedComment(
      "comment-1",
      first.workpad_comment_body,
      "101",
    );
    const resumedIssue = {
      ...issue([firstComment]),
      updated_at: "2026-07-15T10:02:00Z",
    };
    const second = prepareIssueWorkpadMutation(
      resumedIssue,
      first.report,
      "2026-07-15T10:03:00Z",
      rootGh,
    );

    expect(second.mode).toBe("append");
    expect(second.target_comment_ref).toBe("comment-1");
    expect(second.workpad_comment_body.startsWith(firstComment.body)).toBe(
      true,
    );
    expect(
      parseFailureReportWorkpad(second.workpad_comment_body).entries.map(
        (entry) => entry.revision,
      ),
    ).toEqual([0, 1]);
    expect(findExistingWorkpad(resumedIssue, rootGh)?.revision).toBe(0);
  });

  it("creates a linked successor comment for a different explicitly configured producer", async () => {
    const report = await loadReport();
    const first = prepareIssueWorkpadMutation(
      issue(),
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
    );
    const predecessor = managedComment(
      "comment-1",
      first.workpad_comment_body,
      "101",
    );
    const continued = prepareIssueWorkpadMutation(
      issue([predecessor]),
      first.report,
      "2026-07-15T10:02:00Z",
      rootApp,
    );
    const successor = managedComment(
      "comment-2",
      continued.workpad_comment_body,
      "202",
    );

    expect(continued.mode).toBe("continue");
    expect(continued.target_comment_ref).toBeUndefined();
    expect(continued.predecessor_comment_ref).toBe("comment-1");
    expect(continued.workpad_comment_body).not.toContain(predecessor.body);
    expect(
      findExistingWorkpad(issue([predecessor, successor]), rootApp),
    ).toMatchObject({
      revision: 1,
      logical_session_id: expect.any(String),
      predecessor_comment_ref: "comment-1",
    });
  });

  it("returns needs_input for a copied marker, an unknown producer, and author mismatch", async () => {
    const report = await loadReport();
    const copiedMarker = managedComment(
      "copied",
      workpadMarker + "\nHuman copied this marker.",
      "999",
    );
    const valid = prepareIssueWorkpadMutation(
      issue(),
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
    );
    const unknownProducer = managedComment(
      "unknown",
      valid.workpad_comment_body.replace(/root-gh/g, "unregistered"),
      "101",
    );
    const authorMismatch = managedComment(
      "author-mismatch",
      valid.workpad_comment_body,
      "999",
    );

    for (const target of [
      issue([copiedMarker]),
      issue([unknownProducer]),
      issue([authorMismatch]),
    ]) {
      expect(() => findExistingWorkpad(target, rootGh)).toThrow(
        WorkpadNeedsInputError,
      );
    }
  });

  it("returns needs_input for multiple roots and concurrent lineage forks", async () => {
    const report = await loadReport();
    const root = prepareIssueWorkpadMutation(
      issue(),
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
    );
    const rootA = managedComment("root-a", root.workpad_comment_body, "101");
    const rootB = managedComment("root-b", root.workpad_comment_body, "101");
    expect(() => findExistingWorkpad(issue([rootA, rootB]), rootGh)).toThrow(
      "exactly one root",
    );

    const continuation = prepareIssueWorkpadMutation(
      issue([rootA]),
      root.report,
      "2026-07-15T10:02:00Z",
      rootApp,
    );
    const forkA = managedComment(
      "fork-a",
      continuation.workpad_comment_body,
      "202",
    );
    const forkB = managedComment(
      "fork-b",
      continuation.workpad_comment_body,
      "202",
    );
    expect(() =>
      findExistingWorkpad(issue([rootA, forkA, forkB]), rootGh),
    ).toThrow("fork");
  });
});
