import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createGithubIssueChannel,
  createGithubPendingInputHandler,
  createRootCompatibleTurnStartedHandler,
} from "../agent/channels/github.js";
import {
  authorizeGithubIssueChannelActor,
  type GithubInstallationMembershipClient,
} from "../agent/lib/integrations/github/channel-authorization.js";
import { GithubPendingInputRegistry } from "../agent/lib/integrations/github/channel-pending-input.js";
import {
  type GithubIssueChannelPolicy,
  parseGithubIssueChannelPolicy,
  readGithubIssueChannelRuntimeConfig,
} from "../agent/lib/integrations/github/channel-policy.js";

const webhookSecret = "test-webhook-secret";
const credentials = {
  installationToken: "test-installation-token",
  webhookSecret,
};

/** Covers the deployment-owned policy boundary before any webhook is accepted. */
describe("GitHub Issue Channel policy", () => {
  it("parses an explicit repository-to-team policy and leaves the channel disabled when absent", () => {
    const config = readGithubIssueChannelRuntimeConfig({
      FAILURE_REPORT_GITHUB_CHANNEL_BOT_NAME: "failure-report",
      FAILURE_REPORT_GITHUB_CHANNEL_POLICY: JSON.stringify({
        repositories: [
          {
            organization: "Acme",
            repository: "Acme/FailureReport",
            team_slugs: ["operators", "maintainers"],
          },
        ],
      }),
    });

    expect(config).toEqual({
      botName: "failure-report",
      policy: {
        repositories: [
          {
            organization: "Acme",
            repository: "Acme/FailureReport",
            team_slugs: ["operators", "maintainers"],
          },
        ],
      },
      progressReactions: true,
    });
    expect(readGithubIssueChannelRuntimeConfig({})).toBeUndefined();
  });

  it("rejects malformed, ambiguous, mismatched, and empty team configuration", () => {
    expect(() => parseGithubIssueChannelPolicy("not-json")).toThrow(
      "valid JSON",
    );
    expect(() =>
      parseGithubIssueChannelPolicy(
        JSON.stringify({
          repositories: [
            {
              organization: "Other",
              repository: "Acme/FailureReport",
              team_slugs: ["operators"],
            },
          ],
        }),
      ),
    ).toThrow("organization must match");
    expect(() =>
      parseGithubIssueChannelPolicy(
        JSON.stringify({
          repositories: [
            {
              organization: "Acme",
              repository: "Acme/FailureReport",
              team_slugs: [],
            },
          ],
        }),
      ),
    ).toThrow("at least one team slug");
    expect(() =>
      parseGithubIssueChannelPolicy(
        JSON.stringify({
          repositories: [
            {
              organization: "Acme",
              repository: "Acme/FailureReport",
              team_slugs: ["operators"],
            },
            {
              organization: "acme",
              repository: "acme/failurereport",
              team_slugs: ["maintainers"],
            },
          ],
        }),
      ),
    ).toThrow("duplicate repository");
  });
});

/** Covers each membership result without exposing raw API responses to Root. */
describe("GitHub Issue Channel membership authorization", () => {
  it("requires an active membership and fails closed for pending, absent, API, permission, and repository failures", async () => {
    const active = membershipClient({ operators: { state: "active" } });
    await expect(
      authorizeGithubIssueChannelActor({
        client: active.client,
        policy: policy(),
        repository: "Acme/FailureReport",
        senderLogin: "alice",
      }),
    ).resolves.toEqual({ authorized: true });

    await expect(
      authorizeGithubIssueChannelActor({
        client: membershipClient({ operators: { state: "pending" } }).client,
        policy: policy(),
        repository: "Acme/FailureReport",
        senderLogin: "alice",
      }),
    ).resolves.toEqual({ authorized: false, reason: "inactive_membership" });

    await expect(
      authorizeGithubIssueChannelActor({
        client: membershipClient({ operators: { state: "inactive" } }).client,
        policy: policy(),
        repository: "Acme/FailureReport",
        senderLogin: "alice",
      }),
    ).resolves.toEqual({ authorized: false, reason: "inactive_membership" });

    await expect(
      authorizeGithubIssueChannelActor({
        client: membershipClient({ operators: { status: 404 } }).client,
        policy: policy(),
        repository: "Acme/FailureReport",
        senderLogin: "alice",
      }),
    ).resolves.toEqual({ authorized: false, reason: "inactive_membership" });

    for (const failure of [
      { status: 403 },
      { status: 500 },
      new Error("offline"),
    ]) {
      await expect(
        authorizeGithubIssueChannelActor({
          client: membershipClient({ operators: failure }).client,
          policy: policy(),
          repository: "Acme/FailureReport",
          senderLogin: "alice",
        }),
      ).resolves.toEqual({
        authorized: false,
        reason: "membership_lookup_failed",
      });
    }

    const unconfigured = membershipClient({ operators: { state: "active" } });
    await expect(
      authorizeGithubIssueChannelActor({
        client: unconfigured.client,
        policy: policy(),
        repository: "Acme/Other",
        senderLogin: "alice",
      }),
    ).resolves.toEqual({
      authorized: false,
      reason: "unconfigured_repository",
    });
    expect(unconfigured.calls).toEqual([]);
  });

  it("checks every configured team so an inaccessible team cannot be masked by another active one", async () => {
    const membership = membershipClient({
      maintainers: { status: 403 },
      operators: { state: "active" },
    });
    const configuredPolicy = parseGithubIssueChannelPolicy(
      JSON.stringify({
        repositories: [
          {
            organization: "Acme",
            repository: "Acme/FailureReport",
            team_slugs: ["operators", "maintainers"],
          },
        ],
      }),
    );

    await expect(
      authorizeGithubIssueChannelActor({
        client: membership.client,
        policy: configuredPolicy,
        repository: "Acme/FailureReport",
        senderLogin: "alice",
      }),
    ).resolves.toEqual({
      authorized: false,
      reason: "membership_lookup_failed",
    });
    expect(membership.calls).toHaveLength(2);
  });
});

/** Exercises the native webhook route plus the authored Issue-only gate. */
describe("GitHub Issue Channel dispatch", () => {
  it("dispatches an authorized Issue mention with actor context and no policy or membership evidence", async () => {
    const fetch = activeMembershipFetch();
    const channel = createChannel(fetch);

    const dispatched = await dispatchWebhook(
      channel,
      "issue_comment",
      issueCommentPayload("@failure-report investigate this failure"),
    );

    expect(dispatched.response.status).toBe(200);
    expect(dispatched.send).toHaveBeenCalledOnce();
    const [, options] = dispatched.send.mock.calls[0] ?? [];
    expect(options.auth).toMatchObject({
      principalId: "github:101",
      subject: "alice",
    });
    expect(JSON.stringify(options)).not.toContain("operators");
    expect(JSON.stringify(options)).not.toContain("active");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("continues one known missing-input reply with a fresh authorization check", async () => {
    const fetch = activeMembershipFetch();
    const pendingInputs = new GithubPendingInputRegistry();
    const channel = createChannel(fetch, pendingInputs);
    const prompt = vi.fn().mockResolvedValue({ id: 99 });
    const inputHandler = createGithubPendingInputHandler(pendingInputs);

    await inputHandler(
      { requests: [missingInformationRequest()] } as never,
      {
        conversation: {
          issueNumber: 42,
          kind: "issue",
          pullRequestNumber: null,
        },
        repository: { id: 17 },
        thread: { post: prompt },
      } as never,
      {} as never,
    );
    expect(prompt).toHaveBeenCalledWith(
      expect.stringContaining("What changed immediately before the failure?"),
    );
    expect(prompt.mock.calls[0]?.[0]).not.toContain("request-1");

    const initial = await dispatchWebhook(
      channel,
      "issue_comment",
      issueCommentPayload("@failure-report begin"),
    );
    const continuation = await dispatchWebhook(
      channel,
      "issue_comment",
      issueCommentPayload("The deploy changed the node version."),
    );

    expect(initial.send).toHaveBeenCalledOnce();
    expect(continuation.send).toHaveBeenCalledOnce();
    expect(continuation.send.mock.calls[0]?.[0]).toEqual({
      inputResponses: [
        {
          requestId: "request-1",
          text: "The deploy changed the node version.",
        },
      ],
    });
    expect(continuation.send.mock.calls[0]?.[1].auth).toMatchObject({
      principalId: "github:101",
    });
    expect(JSON.stringify(continuation.send.mock.calls[0]?.[1])).not.toContain(
      "pending-input",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps ordinary comments and ambiguous or approval-like pending replies inert", async () => {
    const fetch = activeMembershipFetch();
    const pendingInputs = new GithubPendingInputRegistry();
    const channel = createChannel(fetch, pendingInputs);

    const ordinary = await dispatchWebhook(
      channel,
      "issue_comment",
      issueCommentPayload("This is ordinary Issue discussion."),
    );
    expect(ordinary.send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    pendingInputs.register({ issueNumber: 42, repositoryId: 17 }, [
      missingInformationRequest(),
      missingInformationRequest("request-2"),
    ]);
    const ambiguous = await dispatchWebhook(
      channel,
      "issue_comment",
      issueCommentPayload("Some context"),
    );
    expect(ambiguous.send).not.toHaveBeenCalled();

    pendingInputs.register({ issueNumber: 42, repositoryId: 17 }, [
      {
        action: { toolName: "prepare_diagnostic_session" },
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
        prompt: "Approve this action?",
        requestId: "approval-1",
      },
    ]);
    const approval = await dispatchWebhook(
      channel,
      "issue_comment",
      issueCommentPayload("approve"),
    );
    expect(approval.send).not.toHaveBeenCalled();
  });

  it("does not dispatch PR, review, Issue-open, CI, unconfigured, rejected, or unsigned deliveries", async () => {
    const fetch = activeMembershipFetch();
    const channel = createChannel(fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(channel.receive).toBeUndefined();

    try {
      for (const [event, payload] of [
        [
          "issue_comment",
          issueCommentPayload("@failure-report investigate", true),
        ],
        ["pull_request_review_comment", reviewCommentPayload()],
        ["issues", issueOpenedPayload()],
        ["check_suite", checkSuitePayload()],
      ] as const) {
        const dispatched = await dispatchWebhook(channel, event, payload);
        expect(dispatched.send).not.toHaveBeenCalled();
      }

      const unconfigured = await dispatchWebhook(
        channel,
        "issue_comment",
        issueCommentPayload("@failure-report investigate", false, "Acme/Other"),
      );
      expect(unconfigured.send).not.toHaveBeenCalled();

      const denied = await dispatchWebhook(
        createChannel(permissionDeniedFetch()),
        "issue_comment",
        issueCommentPayload("@failure-report investigate"),
      );
      expect(denied.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "failure-report.github-issue-channel.authorization-lookup-failed",
      );

      const unsigned = await dispatchWebhook(
        channel,
        "issue_comment",
        issueCommentPayload("@failure-report investigate"),
        "not-a-valid-signature",
      );
      expect(unsigned.response.status).toBe(401);
      expect(unsigned.send).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/** Proves the custom handler preserves progress without requesting a sandbox. */
describe("GitHub Issue Channel checkout suppression", () => {
  it("reacts without asking Eve for a sandbox, checkout path, or Git operation", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const getSandbox = vi.fn(() => {
      throw new Error("checkout must not be reached");
    });
    const handler = createRootCompatibleTurnStartedHandler(true);

    await handler(
      {} as never,
      {
        state: { checkoutPath: null },
        thread: { react },
      } as never,
      { getSandbox } as never,
    );

    expect(react).toHaveBeenCalledWith("eyes");
    expect(getSandbox).not.toHaveBeenCalled();
  });
});

function policy(): GithubIssueChannelPolicy {
  return parseGithubIssueChannelPolicy(
    JSON.stringify({
      repositories: [
        {
          organization: "Acme",
          repository: "Acme/FailureReport",
          team_slugs: ["operators"],
        },
      ],
    }),
  );
}

function membershipClient(
  responses: Record<string, { state?: string; status?: number } | Error>,
): { client: GithubInstallationMembershipClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async request({ path }) {
        calls.push(path);
        const teamSlug = path.split("/")[4] ?? "";
        const response = responses[teamSlug];
        if (response instanceof Error) {
          throw response;
        }
        if (response?.status !== undefined) {
          throw Object.assign(new Error("GitHub membership lookup failed"), {
            status: response.status,
          });
        }
        return { body: response ?? {} };
      },
    },
  };
}

function createChannel(
  fetch: typeof globalThis.fetch,
  pendingInputs?: GithubPendingInputRegistry,
) {
  return createGithubIssueChannel(
    {
      botName: "failure-report",
      policy: policy(),
      progressReactions: true,
    },
    {
      api: { fetch },
      credentials,
      pendingInputs,
    },
  );
}

function activeMembershipFetch(): typeof globalThis.fetch {
  return vi.fn(async () => Response.json({ state: "active" })) as typeof fetch;
}

function permissionDeniedFetch(): typeof globalThis.fetch {
  return vi.fn(async () => Response.json({}, { status: 403 })) as typeof fetch;
}

async function dispatchWebhook(
  channel: ReturnType<typeof createChannel>,
  event: string,
  payload: Record<string, unknown>,
  signature = signatureFor(JSON.stringify(payload)),
): Promise<{
  readonly response: Response;
  readonly send: ReturnType<typeof vi.fn>;
}> {
  const body = JSON.stringify(payload);
  const request = new Request("https://example.test/eve/v1/github", {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "delivery-1",
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
    method: "POST",
  });
  const send = vi.fn().mockResolvedValue({ sessionId: "session-1" });
  const pending: Promise<unknown>[] = [];
  const route = channel.routes[0];
  if (!route || route.transport === "websocket") {
    throw new Error("expected the native GitHub HTTP webhook route");
  }
  const response = await route.handler(request, {
    getSession: vi.fn(),
    params: {},
    receive: vi.fn(),
    requestIp: null,
    send,
    waitUntil(task) {
      pending.push(Promise.resolve(task));
    },
  } as never);
  await Promise.all(pending);
  return { response, send };
}

function signatureFor(body: string): string {
  return `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
}

function issueCommentPayload(
  body: string,
  isPullRequest = false,
  fullName = "Acme/FailureReport",
): Record<string, unknown> {
  const [owner, name] = fullName.split("/");
  return {
    action: "created",
    comment: {
      body,
      html_url:
        "https://github.com/Acme/FailureReport/issues/42#issuecomment-9",
      id: 9,
      user: { id: 101, login: "alice", type: "User" },
    },
    installation: { id: 55 },
    issue: {
      ...(isPullRequest ? { pull_request: {} } : {}),
      number: 42,
    },
    repository: {
      full_name: fullName,
      id: 17,
      name,
      owner: { login: owner },
      private: true,
    },
    sender: { id: 101, login: "alice", type: "User" },
  };
}

function reviewCommentPayload(): Record<string, unknown> {
  return {
    action: "created",
    comment: {
      body: "@failure-report review this",
      id: 10,
      user: { id: 101, login: "alice", type: "User" },
    },
    installation: { id: 55 },
    pull_request: {
      base: { ref: "main", repo: { default_branch: "main" }, sha: "base" },
      head: { ref: "feature", sha: "head" },
      number: 9,
    },
    repository: {
      full_name: "Acme/FailureReport",
      id: 17,
      name: "FailureReport",
      owner: { login: "Acme" },
    },
    sender: { id: 101, login: "alice", type: "User" },
  };
}

function issueOpenedPayload(): Record<string, unknown> {
  return {
    action: "opened",
    installation: { id: 55 },
    issue: { number: 42 },
    repository: {
      full_name: "Acme/FailureReport",
      id: 17,
      name: "FailureReport",
      owner: { login: "Acme" },
    },
    sender: { id: 101, login: "alice", type: "User" },
  };
}

function checkSuitePayload(): Record<string, unknown> {
  return {
    action: "completed",
    check_suite: { app: { slug: "github-actions" }, id: 1, pull_requests: [] },
    installation: { id: 55 },
    repository: {
      full_name: "Acme/FailureReport",
      id: 17,
      name: "FailureReport",
      owner: { login: "Acme" },
    },
    sender: { id: 101, login: "alice", type: "User" },
  };
}

function missingInformationRequest(
  requestId = "request-1",
): Record<string, unknown> {
  return {
    action: { toolName: "ask_question" },
    allowFreeform: true,
    prompt: "What changed immediately before the failure?",
    requestId,
  };
}
