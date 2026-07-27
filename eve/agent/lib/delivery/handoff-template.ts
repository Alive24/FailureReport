import { createHash } from "node:crypto";

import {
  handoffDeliveryReceiptSchema,
  type HandoffDeliveryReceipt,
  type ImplementationHandoff,
} from "@failure-report/protocol";

import type { RepositoryHandoffDeliveryPolicy } from "./handoff-delivery-config.js";

const deliveryMarkerPrefix = "<!-- failure-report-handoff-delivery/v1 ";
const knownTemplateVariables = [
  "diagnostic_snapshot",
  "evidence_refs",
  "goal",
  "guardrails",
  "handoff_id",
  "report_id",
  "required_outcomes",
  "residual_risks",
  "scope_in",
  "scope_out",
  "target",
  "verification",
  "why_now",
] as const;
const requiredTemplateVariables = [
  "diagnostic_snapshot",
  "goal",
  "required_outcomes",
  "scope_in",
  "verification",
] as const;

/** Stable delivery preparation before any provider side effect occurs. */
export type PreparedHandoffDelivery = {
  delivery_id: string;
  marker: string;
  template_digest: string;
  comment_body: string;
};

/** Renders a configurable human view followed by the canonical folded payload. */
export function prepareHandoffDelivery(input: {
  handoff: ImplementationHandoff;
  policy: RepositoryHandoffDeliveryPolicy;
  template: string;
}): PreparedHandoffDelivery {
  assertTemplate(input.template);
  const templateDigest = digest(input.template);
  const deliveryId =
    "failure-report/handoff-delivery/sha256/" +
    createHash("sha256")
      .update(
        canonicalJson({
          handoff_id: input.handoff.handoff_id,
          template_digest: templateDigest,
          tracker: input.policy.tracker,
        }),
      )
      .digest("hex");
  const marker = `${deliveryMarkerPrefix}id="${deliveryId}" -->`;
  const humanView = renderTemplate(input.template, input.handoff);
  const intent = {
    schema_version: "failure-report/handoff-delivery-intent/v1",
    delivery_id: deliveryId,
    handoff_id: input.handoff.handoff_id,
    template: { content_digest: templateDigest },
    tracker: {
      kind: input.policy.tracker.kind,
      project_owner: input.policy.tracker.project_owner,
      project_owner_type: input.policy.tracker.project_owner_type,
      project_number: input.policy.tracker.project_number,
      status_field: input.policy.tracker.status_field,
      state: input.policy.tracker.ready_destination,
    },
  };
  return {
    delivery_id: deliveryId,
    marker,
    template_digest: templateDigest,
    comment_body: [
      marker,
      humanView.trimEnd(),
      "",
      "<details>",
      "<summary>Canonical FailureReport handoff and delivery intent</summary>",
      "",
      "~~~json",
      JSON.stringify(
        {
          delivery: intent,
          implementation_handoff: input.handoff,
        },
        null,
        2,
      ),
      "~~~",
      "</details>",
      "",
    ].join("\n"),
  };
}

/** Constructs the public acknowledgement after comment and tracker readback. */
export function createHandoffDeliveryReceipt(input: {
  handoff: ImplementationHandoff;
  policy: RepositoryHandoffDeliveryPolicy;
  prepared: PreparedHandoffDelivery;
  comment_ref: string;
}): HandoffDeliveryReceipt {
  return handoffDeliveryReceiptSchema.parse({
    schema_version: "failure-report/handoff-delivery/v1",
    delivery_id: input.prepared.delivery_id,
    handoff_id: input.handoff.handoff_id,
    report: input.handoff.report,
    template: {
      content_digest: input.prepared.template_digest,
    },
    comment: {
      ref: input.comment_ref,
    },
    tracker: {
      kind: input.policy.tracker.kind,
      project_owner: input.policy.tracker.project_owner,
      project_owner_type: input.policy.tracker.project_owner_type,
      project_number: input.policy.tracker.project_number,
      status_field: input.policy.tracker.status_field,
      state: input.policy.tracker.ready_destination,
    },
  });
}

function assertTemplate(template: string): void {
  if (template.includes(deliveryMarkerPrefix)) {
    throw new Error(
      "Configured handoff template contains a reserved delivery marker.",
    );
  }
  const variableMatches = [...template.matchAll(/\{\{([^{}]+)\}\}/gu)];
  const variables = variableMatches.map((match) => match[1]?.trim() ?? "");
  const matchedTemplate = variableMatches.reduce(
    (value, match) => value.replace(match[0], ""),
    template,
  );
  if (matchedTemplate.includes("{{") || matchedTemplate.includes("}}")) {
    throw new Error("Configured handoff template has invalid variable syntax.");
  }
  const unknown = variables.filter(
    (variable) =>
      !knownTemplateVariables.includes(
        variable as (typeof knownTemplateVariables)[number],
      ),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Configured handoff template contains unknown variables: ${[
        ...new Set(unknown),
      ].join(", ")}.`,
    );
  }
  const missing = requiredTemplateVariables.filter(
    (variable) => !variables.includes(variable),
  );
  if (missing.length > 0) {
    throw new Error(
      `Configured handoff template is missing required variables: ${missing.join(
        ", ",
      )}.`,
    );
  }
}

function renderTemplate(
  template: string,
  handoff: ImplementationHandoff,
): string {
  const values: Record<(typeof knownTemplateVariables)[number], string> = {
    diagnostic_snapshot:
      `[\`${handoff.diagnostic_snapshot.remote_ref}\`](` +
      `${handoff.diagnostic_snapshot.remote_url}) at ` +
      `\`${handoff.diagnostic_snapshot.head_revision}\` ` +
      "(`diagnostic_snapshot_only`)",
    evidence_refs: bullets(handoff.evidence_refs.map(code)),
    goal: handoff.contract.goal,
    guardrails: bullets(handoff.contract.guardrails),
    handoff_id: code(handoff.handoff_id),
    report_id: code(handoff.report.report_id),
    required_outcomes: bullets(handoff.contract.required_outcomes),
    residual_risks:
      handoff.contract.residual_risks.length > 0
        ? bullets(handoff.contract.residual_risks)
        : "- None recorded.",
    scope_in: bullets(handoff.contract.scope_in),
    scope_out:
      handoff.contract.scope_out.length > 0
        ? bullets(handoff.contract.scope_out)
        : "- None.",
    target: code(`${handoff.target.repository}@${handoff.target.revision}`),
    verification: renderVerification(handoff),
    why_now: handoff.contract.why_now,
  };
  return template.replace(
    /\{\{([^{}]+)\}\}/gu,
    (_match, rawVariable: string) => {
      const variable = rawVariable.trim();
      const value = values[variable as keyof typeof values];
      if (value === undefined) {
        throw new Error(`Unknown handoff template variable: ${variable}.`);
      }
      return value;
    },
  );
}

function renderVerification(handoff: ImplementationHandoff): string {
  const sections = [
    "### Automated",
    "",
    bullets(handoff.contract.verification.automated),
  ];
  if (handoff.contract.verification.uat.length > 0) {
    sections.push(
      "",
      "### UAT",
      "",
      bullets(handoff.contract.verification.uat),
    );
  }
  if (handoff.contract.verification.context.length > 0) {
    sections.push(
      "",
      "### Context",
      "",
      bullets(handoff.contract.verification.context),
    );
  }
  return sections.join("\n");
}

function bullets(values: readonly string[]): string {
  return values
    .map((value) => `- ${value.replace(/\r?\n/gu, "\n  ")}`)
    .join("\n");
}

function code(value: string): string {
  return `\`${value.replace(/`/gu, "\\`")}\``;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
