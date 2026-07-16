import { describe, expect, it } from "vitest";

import {
  EveChannelRootInvoker,
  InMemoryRootSessionStore,
  type EveChannelRootTransport,
} from "../src/index.js";

/** Exercises session continuity and schema failure behavior at the Channel boundary. */
describe("Eve Channel Root invoker", () => {
  it("uses the shared Issue as the session key and validates structured output", async () => {
    const seen: Array<{ sessionState?: unknown; message: string }> = [];
    const transport: EveChannelRootTransport = {
      async run(input) {
        seen.push(input);
        return {
          data: {
            request_id: "root-issue-54",
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
});
