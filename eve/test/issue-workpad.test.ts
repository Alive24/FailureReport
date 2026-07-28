import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  failureReportSchema,
  parseFailureReportWorkpad,
  renderFailureReportWorkpadHumanView,
  workpadMarker,
} from "@failure-report/protocol";

import {
  WorkpadNeedsInputError,
  encodedWorkpadCommentRequestBytes,
  findExistingWorkpad,
  prepareVerifiedWorkpadManifest,
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
    title: "CKBoost Issue 54",
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
    expect(mutation.workpad_comment_body).toContain("#### Completed diagnosis");
    expect(mutation.workpad_comment_body).toContain("##### Diagnosis");
    expect(mutation.workpad_comment_body).toContain(
      "Canonical context — complete FailureReport snapshot",
    );
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
      100_000,
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

  it("uses the actual encoded-byte boundary and rolls over before overflow", async () => {
    const report = await loadReport();
    const first = prepareIssueWorkpadMutation(
      issue(),
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
    );
    if (first.mode === "chunk") {
      throw new Error("Fixture unexpectedly required chunking.");
    }
    const predecessor = managedComment(
      "comment-1",
      first.workpad_comment_body,
      "101",
    );
    const resumed = issue([predecessor]);
    const unconstrained = prepareIssueWorkpadMutation(
      resumed,
      first.report,
      "2026-07-15T10:02:00Z",
      rootGh,
      100_000,
    );
    if (unconstrained.mode === "chunk") {
      throw new Error("Fixture append unexpectedly required chunking.");
    }
    const exact = encodedWorkpadCommentRequestBytes(
      unconstrained.workpad_comment_body,
    );

    expect(
      prepareIssueWorkpadMutation(
        resumed,
        first.report,
        "2026-07-15T10:02:00Z",
        rootGh,
        exact,
      ).mode,
    ).toBe("append");
    const rollover = prepareIssueWorkpadMutation(
      resumed,
      first.report,
      "2026-07-15T10:02:00Z",
      rootGh,
      exact - 1,
    );
    expect(rollover).toMatchObject({
      mode: "continue",
      predecessor_comment_ref: "comment-1",
      entry: { continuation_kind: "capacity" },
    });
    if (rollover.mode === "chunk") {
      throw new Error("Fixture rollover unexpectedly required chunking.");
    }
    expect(rollover.workpad_comment_body).not.toContain(predecessor.body);
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
    expect(continued.entry.continuation_kind).toBe("producer_transition");
  });

  it("supports repeated capacity continuations mixed with a configured producer transition", async () => {
    const report = await loadReport();
    const first = prepareIssueWorkpadMutation(
      issue(),
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
    );
    if (first.mode === "chunk") {
      throw new Error("Fixture unexpectedly required chunking.");
    }
    const root = managedComment("comment-1", first.workpad_comment_body, "101");
    const append = prepareIssueWorkpadMutation(
      issue([root]),
      first.report,
      "2026-07-15T10:02:00Z",
      rootGh,
      100_000,
    );
    if (append.mode === "chunk") {
      throw new Error("Fixture unexpectedly required chunking.");
    }
    const budget =
      encodedWorkpadCommentRequestBytes(append.workpad_comment_body) - 1;
    const capacityOne = prepareIssueWorkpadMutation(
      issue([root]),
      first.report,
      "2026-07-15T10:02:00Z",
      rootGh,
      budget,
    );
    if (capacityOne.mode === "chunk") {
      throw new Error("Fixture unexpectedly required chunking.");
    }
    const second = managedComment(
      "comment-2",
      capacityOne.workpad_comment_body,
      "101",
    );
    const capacityTwo = prepareIssueWorkpadMutation(
      issue([root, second]),
      capacityOne.report,
      "2026-07-15T10:03:00Z",
      rootGh,
      budget,
    );
    if (capacityTwo.mode === "chunk") {
      throw new Error("Fixture unexpectedly required chunking.");
    }
    const third = managedComment(
      "comment-3",
      capacityTwo.workpad_comment_body,
      "101",
    );
    const transition = prepareIssueWorkpadMutation(
      issue([root, second, third]),
      capacityTwo.report,
      "2026-07-15T10:04:00Z",
      rootApp,
      budget,
    );
    if (transition.mode === "chunk") {
      throw new Error("Fixture unexpectedly required chunking.");
    }
    const fourth = managedComment(
      "comment-4",
      transition.workpad_comment_body,
      "202",
    );
    expect(
      findExistingWorkpad(issue([root, second, third, fourth]), rootGh),
    ).toMatchObject({
      revision: 3,
      comment: { id: "comment-4" },
      continuation_kind: "producer_transition",
    });
  });

  it("keeps provisional chunks non-authoritative, reuses verified retry chunks, and commits through one manifest", async () => {
    const report = await loadReport();
    const planned = prepareIssueWorkpadMutation(
      issue(),
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
      15_000,
    );
    expect(planned.mode).toBe("chunk");
    if (planned.mode !== "chunk") {
      throw new Error("Expected a chunked publication.");
    }
    const provisional = planned.chunks.map((chunk, index) =>
      managedComment(
        "chunk-" + String(index),
        chunk.workpad_comment_body,
        "101",
      ),
    );
    const interrupted = issue(provisional);
    expect(findExistingWorkpad(interrupted, rootGh)).toBeUndefined();

    const retried = prepareIssueWorkpadMutation(
      interrupted,
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
      15_000,
    );
    expect(retried.mode).toBe("chunk");
    if (retried.mode !== "chunk") {
      throw new Error("Expected a chunked retry.");
    }
    expect(retried.chunks.map((chunk) => chunk.existing_comment_ref)).toEqual(
      provisional.map((comment) => comment.id),
    );

    const manifest = prepareVerifiedWorkpadManifest(
      interrupted,
      planned,
      provisional.map((comment) => comment.id),
      rootGh,
    );
    const inlineHumanView = renderFailureReportWorkpadHumanView(planned.entry);
    const stageStart = "\n#### Completed diagnosis";
    expect(
      manifest
        .slice(manifest.indexOf(stageStart), manifest.indexOf("\n<details>"))
        .trimEnd(),
    ).toBe(
      inlineHumanView.slice(inlineHumanView.indexOf(stageStart)).trimEnd(),
    );
    expect(manifest).toContain("Authoritative comment group");
    expect(manifest).toContain(
      "Canonical context — verified multi-comment manifest",
    );
    const head = findExistingWorkpad(
      issue([...provisional, managedComment("manifest-1", manifest, "101")]),
      rootGh,
    );
    expect(head).toMatchObject({
      revision: 0,
      comment: { id: "manifest-1" },
      representation: "manifest",
      report: planned.report,
    });
  });

  it("falls back to a fresh group for ambiguous retry chunks and rejects foreign referenced provenance", async () => {
    const report = await loadReport();
    const planned = prepareIssueWorkpadMutation(
      issue(),
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
      15_000,
    );
    if (planned.mode !== "chunk") {
      throw new Error("Expected a chunked publication.");
    }
    const provisional = planned.chunks.map((chunk, index) =>
      managedComment(
        "chunk-" + String(index),
        chunk.workpad_comment_body,
        "101",
      ),
    );
    const duplicated = managedComment(
      "chunk-duplicate",
      planned.chunks[0]?.workpad_comment_body ?? "",
      "101",
    );
    const fresh = prepareIssueWorkpadMutation(
      issue([...provisional, duplicated]),
      report,
      "2026-07-15T10:01:00Z",
      rootGh,
      15_000,
    );
    expect(fresh.mode).toBe("chunk");
    if (fresh.mode !== "chunk") {
      throw new Error("Expected a fresh chunked publication.");
    }
    expect(fresh.group.group_id).not.toBe(planned.group.group_id);
    expect(fresh.chunks.every((chunk) => !chunk.existing_comment_ref)).toBe(
      true,
    );

    const manifest = prepareVerifiedWorkpadManifest(
      issue(provisional),
      planned,
      provisional.map((comment) => comment.id),
      rootGh,
    );
    const foreign = [
      { ...provisional[0], author: { id: "999" } },
      ...provisional.slice(1),
      managedComment("manifest-1", manifest, "101"),
    ] as GithubIssueComment[];
    expect(() => findExistingWorkpad(issue(foreign), rootGh)).toThrow(
      "foreign-author",
    );
  });

  it("returns needs_input for a copied marker, a legacy v1 payload, an unknown producer, and author mismatch", async () => {
    const report = await loadReport();
    const copiedMarker = managedComment(
      "copied",
      workpadMarker + "\nHuman copied this marker.",
      "999",
    );
    const legacy = managedComment(
      "legacy",
      workpadMarker +
        '\n<!-- failure-report/v1 report-id="old" revision="0" -->',
      "101",
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
      issue([legacy]),
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
