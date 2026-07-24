import { defineChannel, type SendFn } from "eve/channels";
import {
  defaultGitHubAuth,
  githubChannel,
  type GitHubApiOptions,
  type GitHubChannel,
  type GitHubChannelConfig,
  type GitHubChannelCredentials,
  type GitHubChannelEvents,
  type GitHubChannelState,
} from "eve/channels/github";

import {
  authorizeGithubIssueChannelActor,
  type GithubIssueChannelAuthorization,
} from "../lib/integrations/github/channel-authorization.js";
import {
  GithubPendingInputRegistry,
  type GithubIssueConversation,
  renderGithubPendingInputPrompt,
} from "../lib/integrations/github/channel-pending-input.js";
import {
  type GithubIssueChannelRuntimeConfig,
  readGithubIssueChannelRuntimeConfig,
} from "../lib/integrations/github/channel-policy.js";

/** Deployment and focused-test seams for native GitHub Channel credentials. */
export type GithubIssueChannelDependencies = {
  readonly api?: GitHubApiOptions;
  readonly authorize?: (input: {
    readonly client: Parameters<
      typeof authorizeGithubIssueChannelActor
    >[0]["client"];
    readonly policy: GithubIssueChannelRuntimeConfig["policy"];
    readonly repository: string;
    readonly senderLogin: string;
  }) => Promise<GithubIssueChannelAuthorization>;
  readonly credentials?: GitHubChannelCredentials;
  readonly pendingInputs?: GithubPendingInputRegistry;
};

/** Builds the Issue-only GitHub Channel from deployment-owned configuration. */
export function createGithubIssueChannel(
  config: GithubIssueChannelRuntimeConfig,
  dependencies: GithubIssueChannelDependencies = {},
): GitHubChannel {
  const pendingInputs =
    dependencies.pendingInputs ?? new GithubPendingInputRegistry();

  const channel = githubChannel({
    api: dependencies.api,
    botName: config.botName,
    credentials: dependencies.credentials,
    events: {
      "input.requested": createGithubPendingInputHandler(pendingInputs),
      "turn.started": createRootCompatibleTurnStartedHandler(
        config.progressReactions,
      ),
    },
    onComment: createGithubIssueCommentHandler(
      config,
      pendingInputs,
      dependencies.authorize ?? authorizeGithubIssueChannelActor,
    ),
  });
  return wrapNativeGithubDelivery(channel, pendingInputs);
}

/**
 * Replaces Eve's default `turn.started` checkout handler. Root alone owns the
 * source cache and diagnostic worktree, so this preserves only the harmless
 * acknowledgement reaction and never asks Eve for a sandbox.
 */
export function createRootCompatibleTurnStartedHandler(
  progressReactions: boolean,
): NonNullable<GitHubChannelEvents["turn.started"]> {
  return async (_event, channel) => {
    if (!progressReactions) {
      return;
    }
    try {
      await channel.thread.react("eyes");
    } catch {
      // Match Eve's best-effort progress behavior without exposing API details.
    }
  };
}

/** Posts and registers only one safe missing-information request per Issue. */
export function createGithubPendingInputHandler(
  pendingInputs: GithubPendingInputRegistry,
): NonNullable<GitHubChannelEvents["input.requested"]> {
  return async (event, channel) => {
    const conversation = issueConversation(channel);
    if (!conversation) {
      return;
    }
    const registration = pendingInputs.register(conversation, event.requests);
    if (!registration) {
      return;
    }

    try {
      await channel.thread.post(
        renderGithubPendingInputPrompt(registration.request),
      );
    } catch {
      pendingInputs.clear(registration);
    }
  };
}

/**
 * Dispatches only Issue timeline mentions or a single resolvable pending answer.
 * Authorization happens after trigger correlation and on every accepted comment.
 */
export function createGithubIssueCommentHandler(
  config: GithubIssueChannelRuntimeConfig,
  pendingInputs: GithubPendingInputRegistry,
  authorize: NonNullable<
    GithubIssueChannelDependencies["authorize"]
  > = authorizeGithubIssueChannelActor,
): NonNullable<GitHubChannelConfig["onComment"]> {
  return async (context, comment) => {
    const conversation = issueConversation(context);
    if (
      !conversation ||
      context.delivery.event !== "issue_comment" ||
      !isWebhookCommentAuthor(context.sender, comment.author)
    ) {
      return null;
    }

    const isMention = hasBotMention(comment.body, config.botName);
    const claim = isMention
      ? undefined
      : pendingInputs.claim(conversation, comment.body);
    if (!isMention && !claim) {
      return null;
    }

    let authorization: GithubIssueChannelAuthorization;
    try {
      authorization = await authorize({
        client: context.github,
        policy: config.policy,
        repository: context.repository.fullName,
        senderLogin: context.sender.login,
      });
    } catch {
      if (claim) {
        pendingInputs.release(claim);
      }
      reportGithubIssueAuthorizationFailure();
      return null;
    }
    if (!authorization.authorized) {
      if (claim) {
        pendingInputs.release(claim);
      }
      if (authorization.reason === "membership_lookup_failed") {
        reportGithubIssueAuthorizationFailure();
      }
      return null;
    }

    const pendingInputDelivery = claim
      ? pendingInputs.queueDelivery(claim)
      : undefined;
    if (claim && !pendingInputDelivery) {
      pendingInputs.release(claim);
      return null;
    }
    // Eve's default auth carries only actor and repository attribution, never policy.
    return {
      auth: withPendingInputDelivery(
        defaultGitHubAuth(context),
        pendingInputDelivery,
      ),
    };
  };
}

const PENDING_INPUT_DELIVERY_ATTRIBUTE =
  "failure_report.github_pending_input_delivery";

type GithubActorAuth = ReturnType<typeof defaultGitHubAuth>;

let hasReportedGithubIssueAuthorizationFailure = false;

/**
 * Eve 0.24.4 decorates GitHub comment text before resolving it against a
 * parked input request. Passing a known answer as `inputResponses` keeps its
 * native route, verifier, session, and reply behavior while avoiding a fresh
 * Root turn or a context-decorated free-form answer. This narrow compatibility
 * shim neither parses webhooks nor creates a second public route.
 */
function wrapNativeGithubDelivery(
  channel: GitHubChannel,
  pendingInputs: GithubPendingInputRegistry,
): GitHubChannel {
  // The factory's cross-channel `receive` hook would permit proactive sends.
  // This Issue-only ingress intentionally exports no such path in v1.
  const { receive: _proactiveReceive, ...issueOnlyChannel } = channel;
  return {
    ...issueOnlyChannel,
    routes: channel.routes.map((route) => {
      if (route.transport === "websocket") {
        return route;
      }
      return {
        ...route,
        handler: (request, args) =>
          route.handler(request, {
            ...args,
            send: wrapNativeGithubSend(args.send, pendingInputs),
          }),
      };
    }),
  };
}

function wrapNativeGithubSend(
  send: SendFn<GitHubChannelState>,
  pendingInputs: GithubPendingInputRegistry,
): SendFn<GitHubChannelState> {
  return async (payload, options) => {
    const marker = pendingInputDeliveryMarker(options.auth);
    const response = marker ? pendingInputs.takeDelivery(marker) : undefined;
    return send(response ? { inputResponses: [response] } : payload, {
      ...options,
      auth: withoutPendingInputDelivery(options.auth),
    });
  };
}

function withPendingInputDelivery(
  auth: GithubActorAuth,
  marker: string | undefined,
): GithubActorAuth {
  if (!marker) {
    return auth;
  }
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      [PENDING_INPUT_DELIVERY_ATTRIBUTE]: marker,
    },
  };
}

function pendingInputDeliveryMarker(
  auth: GithubActorAuth | null,
): string | undefined {
  const marker = auth?.attributes[PENDING_INPUT_DELIVERY_ATTRIBUTE];
  return typeof marker === "string" ? marker : undefined;
}

function withoutPendingInputDelivery(
  auth: GithubActorAuth | null,
): GithubActorAuth | null {
  if (!auth || !pendingInputDeliveryMarker(auth)) {
    return auth;
  }
  const attributes = { ...auth.attributes };
  delete attributes[PENDING_INPUT_DELIVERY_ATTRIBUTE];
  return { ...auth, attributes };
}

function reportGithubIssueAuthorizationFailure(): void {
  if (hasReportedGithubIssueAuthorizationFailure) {
    return;
  }
  hasReportedGithubIssueAuthorizationFailure = true;
  // GitHub errors can carry raw API bodies, so operator telemetry uses only a
  // fixed once-per-process outcome code, never policy, membership, actor, or secrets.
  console.warn(
    "failure-report.github-issue-channel.authorization-lookup-failed",
  );
}

function issueConversation(input: {
  readonly conversation: {
    readonly issueNumber: number | null;
    readonly kind: string;
    readonly pullRequestNumber: number | null;
  };
  readonly repository: { readonly id: number };
}): GithubIssueConversation | undefined {
  if (
    input.conversation.kind !== "issue" ||
    input.conversation.issueNumber === null ||
    input.conversation.pullRequestNumber !== null
  ) {
    return undefined;
  }
  return {
    issueNumber: input.conversation.issueNumber,
    repositoryId: input.repository.id,
  };
}

function isWebhookCommentAuthor(
  sender: { readonly id: number; readonly login: string },
  author: { readonly id: number; readonly login: string } | undefined,
): boolean {
  return (
    author?.id === sender.id &&
    author.login.toLowerCase() === sender.login.toLowerCase()
  );
}

function hasBotMention(body: string, botName: string): boolean {
  const escapedBotName = botName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`@${escapedBotName}(?=$|[^A-Za-z0-9_-])`, "iu").test(body);
}

const runtimeConfig = readGithubIssueChannelRuntimeConfig();

// An empty authored channel keeps the GitHub route absent until policy enables it.
export default runtimeConfig
  ? createGithubIssueChannel(runtimeConfig)
  : defineChannel({ routes: [] });
