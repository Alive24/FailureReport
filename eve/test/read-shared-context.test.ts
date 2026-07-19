import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { failureReportSchema } from "@failure-report/protocol";

import {
  prepareIssueWorkpadMutation,
  type WorkpadProducerConfiguration,
} from "../agent/lib/integrations/github/issue-workpad.js";
import {
  findVerifiedWorkpadForRead,
  rehydrateSharedContext,
} from "../agent/tools/read_shared_context.js";

const rootGh: WorkpadProducerConfiguration = {
  current: { id: "root-gh", github_actor_id: "101" },
  producers: [{ id: "root-gh", github_actor_id: "101" }],
};

/** Exercises the read-only Root rehydration path used by an initial selector. */
describe("read_shared_context", () => {
  it("returns canonical context for an existing Issue that has no workpad", () => {
    const issue = {
      repository: "Alive24/CKBoost",
      issue_number: 56,
      issue_url: "https://github.com/Alive24/CKBoost/issues/56",
      body: "# Existing human-authored Issue",
      updated_at: "2026-07-18T20:00:00Z",
      comments: [],
    };
    const before = structuredClone(issue);

    const getProducerConfiguration = vi.fn(() => rootGh);
    const result = rehydrateSharedContext(
      issue,
      findVerifiedWorkpadForRead(issue, getProducerConfiguration),
    );

    expect(result.status).toBe("ok");
    expect(result.shared_context).toEqual({
      provider: "github_issue",
      repository: "Alive24/CKBoost",
      issue_number: 56,
      issue_url: "https://github.com/Alive24/CKBoost/issues/56",
      workpad_marker: "<!-- failure-report-workpad -->",
      workpad_revision: 0,
    });
    expect(result.report).toBeNull();
    expect(result.workpad).toBeNull();
    expect(result.workpad_comment_ref).toBeNull();
    expect(result.workpad_revision).toBeNull();
    expect(getProducerConfiguration).not.toHaveBeenCalled();
    // The transformation only reads the snapshot. It cannot publish or alter
    // an Issue, comments, diagnostic state, or any caller filesystem state.
    expect(issue).toEqual(before);
  });

  it("derives current comment and revision fields from a persisted workpad", async () => {
    const reportFile = new URL(
      "../../packages/protocol/test/fixtures/issue-54.json",
      import.meta.url,
    );
    const report = failureReportSchema.parse(
      JSON.parse(await readFile(reportFile, "utf8")),
    );
    const issue = {
      repository: "Alive24/CKBoost",
      issue_number: 54,
      issue_url: "https://github.com/Alive24/CKBoost/issues/54",
      body: "# Existing Issue",
      updated_at: "2026-07-18T20:00:00Z",
      comments: [],
    };
    const mutation = prepareIssueWorkpadMutation(
      issue,
      report,
      "2026-07-18T20:01:00Z",
      rootGh,
    );

    const persistedIssue = {
      ...issue,
      comments: [
        {
          id: "IC_workpad_54",
          body: mutation.workpad_comment_body,
          updated_at: "2026-07-18T20:01:00Z",
          author: { id: "101", login: "fixture-root-gh" },
        },
      ],
    };
    const result = rehydrateSharedContext(
      persistedIssue,
      findVerifiedWorkpadForRead(persistedIssue, () => rootGh),
    );

    expect(result.shared_context).toMatchObject({
      repository: "Alive24/CKBoost",
      issue_number: 54,
      workpad_comment_ref: "IC_workpad_54",
      workpad_revision: 0,
      workpad_logical_session_id:
        mutation.report.shared_context?.workpad_logical_session_id,
      workpad_entry_id: mutation.report.shared_context?.workpad_entry_id,
      workpad_producer_id: "root-gh",
    });
    expect(result.workpad).toEqual({
      comment_ref: "IC_workpad_54",
      revision: 0,
    });
    expect(result.report?.id).toBe(report.id);
  });
});
