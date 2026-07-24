/** A minimal, non-sensitive projection of an Eve missing-information request. */
export type GithubPendingInputRequest = {
  readonly action: { readonly toolName: string };
  readonly allowFreeform?: boolean;
  readonly options?: readonly GithubPendingInputOption[];
  readonly prompt: string;
  readonly requestId: string;
};

/** One selectable answer rendered by Eve's native input-request contract. */
export type GithubPendingInputOption = {
  readonly id: string;
  readonly label: string;
};

/** The stable Issue conversation identity used by the native GitHub Channel. */
export type GithubIssueConversation = {
  readonly issueNumber: number;
  readonly repositoryId: number;
};

/** A successful process-local pending-input registration. */
export type GithubPendingInputRegistration = {
  readonly conversation: GithubIssueConversation;
  readonly id: number;
  readonly request: GithubPendingInputRequest;
};

/** The native Eve input response reconstructed from one known Issue reply. */
export type GithubPendingInputResponse = {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
};

/** A temporary claim held while the reply's team authorization is checked. */
export type GithubPendingInputClaim = GithubPendingInputRegistration & {
  readonly reservation: symbol;
  readonly response: GithubPendingInputResponse;
};

type PendingInputRecord = GithubPendingInputRegistration & {
  reservation?: symbol;
};

/**
 * Tracks only one known missing-information request per Issue conversation.
 * It is deliberately process-local: after a restart, uncertain correlation
 * fails closed instead of recreating a public continuation from durable state.
 */
export class GithubPendingInputRegistry {
  private readonly deliveries = new Map<string, GithubPendingInputResponse>();
  private readonly records = new Map<string, PendingInputRecord>();
  private nextDeliveryId = 1;
  private nextId = 1;

  register(
    conversation: GithubIssueConversation,
    requests: readonly unknown[],
  ): GithubPendingInputRegistration | undefined {
    const key = conversationKey(conversation);
    if (key === undefined || requests.length !== 1) {
      if (key !== undefined) {
        this.records.delete(key);
      }
      return undefined;
    }

    const request = requests[0];
    if (!isMissingInformationRequest(request)) {
      this.records.delete(key);
      return undefined;
    }

    const registration: GithubPendingInputRegistration = {
      conversation,
      id: this.nextId++,
      request,
    };
    this.records.set(key, registration);
    return registration;
  }

  claim(
    conversation: GithubIssueConversation,
    body: string,
  ): GithubPendingInputClaim | undefined {
    const record = this.recordFor(conversation);
    const response = record
      ? resolveKnownInput(body, record.request)
      : undefined;
    if (!record || record.reservation || !response) {
      return undefined;
    }

    const reservation = Symbol("github-pending-input");
    record.reservation = reservation;
    return { ...record, reservation, response };
  }

  release(claim: GithubPendingInputClaim): void {
    const record = this.recordFor(claim.conversation);
    if (record?.id === claim.id && record.reservation === claim.reservation) {
      delete record.reservation;
    }
  }

  /**
   * Transfers an authorized response to the native route's `send` wrapper.
   * The opaque marker exists only during that webhook delivery and is removed
   * before Root receives its normal GitHub actor authentication context.
   */
  queueDelivery(claim: GithubPendingInputClaim): string | undefined {
    const key = conversationKey(claim.conversation);
    const record = key === undefined ? undefined : this.records.get(key);
    if (
      key === undefined ||
      record?.id !== claim.id ||
      record.reservation !== claim.reservation
    ) {
      return undefined;
    }

    this.records.delete(key);
    const marker = `pending-input-${this.nextDeliveryId++}`;
    this.deliveries.set(marker, claim.response);
    return marker;
  }

  /** Consumes a one-shot delivery marker; unknown or reused markers fail closed. */
  takeDelivery(marker: string): GithubPendingInputResponse | undefined {
    const response = this.deliveries.get(marker);
    this.deliveries.delete(marker);
    return response;
  }

  clear(registration: GithubPendingInputRegistration): void {
    const key = conversationKey(registration.conversation);
    if (key !== undefined && this.records.get(key)?.id === registration.id) {
      this.records.delete(key);
    }
  }

  private recordFor(
    conversation: GithubIssueConversation,
  ): PendingInputRecord | undefined {
    const key = conversationKey(conversation);
    return key === undefined ? undefined : this.records.get(key);
  }
}

/** Renders a bounded Issue timeline prompt without exposing Eve request IDs. */
export function renderGithubPendingInputPrompt(
  request: GithubPendingInputRequest,
): string {
  const options = request.options?.map(
    (option, index) => `${index + 1}. ${option.label}`,
  );
  const message = [
    request.prompt,
    ...(options && options.length > 0
      ? [`\nChoose one of:\n${options.join("\n")}`]
      : []),
    "\nReply directly in this Issue with the missing information to continue.",
  ].join("\n");
  return message.length <= 4_000 ? message : `${message.slice(0, 3_999)}…`;
}

function isMissingInformationRequest(
  value: unknown,
): value is GithubPendingInputRequest {
  if (!isRecord(value) || !isRecord(value.action)) {
    return false;
  }
  if (
    value.action.toolName !== "ask_question" ||
    !isNonEmptyString(value.requestId) ||
    !isNonEmptyString(value.prompt) ||
    (value.allowFreeform !== undefined &&
      typeof value.allowFreeform !== "boolean")
  ) {
    return false;
  }
  if (value.options === undefined) {
    return true;
  }
  if (!Array.isArray(value.options)) {
    return false;
  }

  const optionKeys = new Set<string>();
  for (const option of value.options) {
    if (
      !isRecord(option) ||
      !isNonEmptyString(option.id) ||
      !isNonEmptyString(option.label)
    ) {
      return false;
    }
    for (const key of [option.id, option.label]) {
      const normalized = key.toLowerCase();
      if (optionKeys.has(normalized)) {
        return false;
      }
      optionKeys.add(normalized);
    }
  }
  return true;
}

function resolveKnownInput(
  body: string,
  request: GithubPendingInputRequest,
): GithubPendingInputResponse | undefined {
  const response = body.trim();
  if (response.length === 0) {
    return undefined;
  }
  const normalized = response.toLowerCase();
  const options = request.options ?? [];
  const matchingId = options.find(
    (option) => option.id.toLowerCase() === normalized,
  );
  if (matchingId) {
    return { optionId: matchingId.id, requestId: request.requestId };
  }
  const matchingLabel = options.find(
    (option) => option.label.toLowerCase() === normalized,
  );
  if (matchingLabel) {
    return { optionId: matchingLabel.id, requestId: request.requestId };
  }
  const optionIndex = Number(normalized);
  if (
    Number.isInteger(optionIndex) &&
    optionIndex > 0 &&
    optionIndex <= options.length
  ) {
    return {
      optionId: options[optionIndex - 1]?.id,
      requestId: request.requestId,
    };
  }
  return request.allowFreeform === true || options.length === 0
    ? { requestId: request.requestId, text: response }
    : undefined;
}

function conversationKey(
  conversation: GithubIssueConversation,
): string | undefined {
  if (
    !Number.isSafeInteger(conversation.repositoryId) ||
    conversation.repositoryId <= 0 ||
    !Number.isSafeInteger(conversation.issueNumber) ||
    conversation.issueNumber <= 0
  ) {
    return undefined;
  }
  return `${conversation.repositoryId}:${conversation.issueNumber}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
