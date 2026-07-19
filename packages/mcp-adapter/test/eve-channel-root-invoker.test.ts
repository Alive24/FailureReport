import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createMcpRootInvoker,
  EveChannelRootInvoker,
  InMemoryRootSessionStore,
  rootSessionKey,
  type EveChannelRootPendingTurnConsumer,
  type EveChannelRootTransport,
} from "../src/index.js";

/** Exercises session continuity and schema failure behavior at the Channel boundary. */
describe("Eve Channel Root invoker", () => {
  it("uses the shared Issue as the session key and validates structured output", async () => {
    const seen: Array<{ sessionState?: unknown; message: string }> = [];
    const responseIds = ["root-issue-54", "root-issue-54-followup"];
    const transport: EveChannelRootTransport = {
      async run(input) {
        seen.push(input);
        return {
          data: {
            request_id: responseIds[seen.length - 1],
            status: "completed",
            summary: "Root rehydrated the Issue workpad.",
          },
          status: "completed",
          sessionState: {
            continuationToken: "eve:issue-54",
            sessionId: "ses_issue_54",
            streamIndex: 4,
          },
        };
      },
    };
    const store = new InMemoryRootSessionStore();
    const invoker = new EveChannelRootInvoker(transport, store);
    const request = {
      request_id: "root-issue-54",
      operation: "inspect" as const,
      issue: {
        provider: "github_issue" as const,
        repository: "Alive24/CKBoost",
        issue_number: 54,
        issue_url: "https://github.com/Alive24/CKBoost/issues/54",
        workpad_marker: "<!-- failure-report-workpad -->" as const,
        workpad_revision: 2,
      },
      message: "Rehydrate the shared Issue context.",
    };

    const result = await invoker.invoke(request);
    // A distinct request id for the same Issue must still reuse the Issue-scoped
    // Eve session rather than fragmenting Root's durable conversation.
    await invoker.invoke({ ...request, request_id: "root-issue-54-followup" });

    expect(result.status).toBe("completed");
    expect(seen[0]?.message).toContain("ROOT_REQUEST_DATA");
    expect(seen[1]?.sessionState).toMatchObject({
      continuationToken: "eve:issue-54",
    });
  });

  it("returns a typed failure when Eve does not satisfy the result schema", async () => {
    const transport: EveChannelRootTransport = {
      async run() {
        return {
          data: { unexpected: true },
          status: "completed",
          sessionState: { streamIndex: 0 },
        };
      },
    };

    const result = await new EveChannelRootInvoker(transport).invoke({
      request_id: "root-invalid-result",
      operation: "start",
      message: "Start a report.",
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("valid structured result");
  });

  it("preserves a no-workpad Issue session across retry, adapter restart, and later full context", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "failure-report-mcp-session-"),
    );
    const sessionStorePath = join(temporaryRoot, "state", "sessions.json");
    const seen: Array<{ sessionState?: unknown; message: string }> = [];
    const recoveredSessionStates: unknown[] = [];
    const rehydratedIssue = {
      provider: "github_issue" as const,
      repository: "Alive24/CKBoost",
      issue_number: 56,
      issue_url: "https://github.com/Alive24/CKBoost/issues/56",
      workpad_marker: "<!-- failure-report-workpad -->" as const,
      // No comment reference means the selected Issue still has no workpad.
      workpad_revision: 0,
    };
    const persistedIssue = {
      ...rehydratedIssue,
      workpad_comment_ref: "IC_workpad_56",
      workpad_revision: 1,
    };

    try {
      const first = createMcpRootInvoker({
        transport: transportForSelectorTurn(
          "existing-issue-start",
          rehydratedIssue,
          seen,
          "eve:issue-56:one",
        ),
        session_store_path: sessionStorePath,
      });
      const firstResult = await first.invoke({
        request_id: "existing-issue-start",
        operation: "start",
        issue_selector: {
          repository: "Alive24/CKBoost",
          issue_number: 56,
        },
        message: "Start from the existing Issue without a workpad.",
      });

      // A new store instance models an MCP adapter process that was restarted.
      const retry = createMcpRootInvoker({
        transport: {
          async run(input) {
            seen.push(input);
            // A timed-out prior adapter invocation completed after its caller
            // disconnected. The retry has already been delivered, but Eve's
            // first stream cursor still ends at this older result.
            return {
              data: {
                request_id: "existing-issue-interrupted",
                status: "completed",
                issue: rehydratedIssue,
                summary: "Root completed the interrupted Issue intake.",
              },
              status: "waiting",
              sessionState: {
                continuationToken: "eve:issue-56:stale",
                sessionId: "session-existing-issue-interrupted",
                streamIndex: 2,
              },
            };
          },
          async consumePendingTurn(input) {
            recoveredSessionStates.push(input.sessionState);
            return {
              data: {
                request_id: "existing-issue-retry",
                status: "completed",
                issue: rehydratedIssue,
                summary: "Root rehydrated the retried existing Issue.",
              },
              status: "waiting",
              sessionState: {
                continuationToken: "eve:issue-56:two",
                sessionId: "session-existing-issue-retry",
                streamIndex: 4,
              },
            };
          },
        } satisfies EveChannelRootTransport & EveChannelRootPendingTurnConsumer,
        session_store_path: sessionStorePath,
      });
      const retryResult = await retry.invoke({
        request_id: "existing-issue-retry",
        operation: "resume",
        issue_selector: {
          repository: "Alive24/CKBoost",
          issue_number: 56,
        },
        message: "Retry the initial Issue intake.",
      });

      const followUp = createMcpRootInvoker({
        transport: transportForSelectorTurn(
          "existing-issue-follow-up",
          persistedIssue,
          seen,
          "eve:issue-56:three",
        ),
        session_store_path: sessionStorePath,
      });
      await followUp.invoke({
        request_id: "existing-issue-follow-up",
        operation: "inspect",
        issue: persistedIssue,
        message: "Inspect the context after Root published its workpad.",
      });

      expect(firstResult.issue).toEqual(rehydratedIssue);
      expect(retryResult).toMatchObject({
        request_id: "existing-issue-retry",
        status: "completed",
        issue: rehydratedIssue,
      });
      expect(
        rootSessionKey({
          request_id: "session-key-selector",
          operation: "start",
          issue_selector: {
            repository: "Alive24/CKBoost",
            issue_number: 56,
          },
        }),
      ).toBe("issue:Alive24/CKBoost#56");
      expect(
        rootSessionKey({
          request_id: "session-key-context",
          operation: "resume",
          issue: persistedIssue,
        }),
      ).toBe("issue:Alive24/CKBoost#56");
      expect(seen[0]?.sessionState).toBeUndefined();
      expect(seen[1]?.sessionState).toMatchObject({
        continuationToken: "eve:issue-56:one",
      });
      expect(recoveredSessionStates[0]).toMatchObject({
        continuationToken: "eve:issue-56:stale",
      });
      expect(seen[2]?.sessionState).toMatchObject({
        continuationToken: "eve:issue-56:two",
      });
      // Draining the already-delivered retry must not submit a duplicate turn.
      expect(seen).toHaveLength(3);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a successful selector turn that omits the rehydrated Issue context", async () => {
    const transport: EveChannelRootTransport = {
      async run() {
        return {
          data: {
            request_id: "selector-without-context",
            status: "completed",
            summary: "Root accepted the selector.",
          },
          status: "completed",
          sessionState: { streamIndex: 1 },
        };
      },
    };

    const result = await new EveChannelRootInvoker(transport).invoke({
      request_id: "selector-without-context",
      operation: "start",
      issue_selector: {
        repository: "Alive24/CKBoost",
        issue_number: 56,
      },
      message: "Start from an existing Issue.",
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("rehydrated Issue context");
  });

  it("does not treat an unmatched result as current when no pending turn can be consumed", async () => {
    const transport: EveChannelRootTransport = {
      async run() {
        return {
          data: {
            request_id: "unrelated-root-request",
            status: "completed",
            summary: "A result for another request.",
          },
          status: "completed",
          sessionState: {
            continuationToken: "eve:unrelated",
            sessionId: "session-unrelated",
            streamIndex: 3,
          },
        };
      },
    };

    const result = await new EveChannelRootInvoker(transport).invoke({
      request_id: "current-root-request",
      operation: "inspect",
      message: "Inspect the current report.",
    });

    expect(result).toMatchObject({
      request_id: "current-root-request",
      status: "failed",
    });
    expect(result.summary).toContain("different request id");
  });
});

/** Creates one deterministic Root response for a selector or later full-context turn. */
function transportForSelectorTurn(
  requestId: string,
  issue: {
    provider: "github_issue";
    repository: string;
    issue_number: number;
    issue_url: string;
    workpad_marker: "<!-- failure-report-workpad -->";
    workpad_comment_ref?: string;
    workpad_revision: number;
  },
  seen: Array<{ sessionState?: unknown; message: string }>,
  continuationToken: string,
): EveChannelRootTransport {
  return {
    async run(input) {
      seen.push(input);
      return {
        data: {
          request_id: requestId,
          status: "completed",
          issue,
          summary: "Root rehydrated an existing Issue without publishing.",
        },
        status: "completed",
        sessionState: {
          continuationToken,
          sessionId: "session-" + requestId,
          streamIndex: 1,
        },
      };
    },
  };
}
