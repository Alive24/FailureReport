import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  implementationHandoffSchema,
  type ImplementationHandoff,
} from "@failure-report/protocol";

import {
  findRepositoryHandoffDeliveryPolicy,
  handoffDeliveryPolicySchema,
  loadHandoffTemplate,
  readHandoffDeliveryPolicy,
  type HandoffDeliveryPolicy,
} from "../agent/lib/delivery/handoff-delivery-config.js";
import { createDiagnosticHandoffDelivery } from "../agent/lib/delivery/handoff-delivery.js";
import { createFailureReportIntakeRouter } from "../agent/lib/delivery/intake-router.js";
import { prepareHandoffDelivery } from "../agent/lib/delivery/handoff-template.js";
import type { GithubIssueGateway } from "../agent/lib/integrations/github/issue-gateway.js";
import type { GithubProjectTracker } from "../agent/lib/integrations/github/project-tracker.js";

const template = `# Implementation Handoff

## Goal

{{goal}}

## Scope

{{scope_in}}

## Required outcomes

{{required_outcomes}}

## Verification

{{verification}}

## Diagnostic snapshot

{{diagnostic_snapshot}}
`;

function policy(
  readyDestination: "Backlog" | "Todo" = "Backlog",
): HandoffDeliveryPolicy {
  return handoffDeliveryPolicySchema.parse({
    schema_version: "failure-report/handoff-delivery-policy/v1",
    repositories: [
      {
        repository: "Alive24/CKBoost",
        template: { path: "config/root/handoffs/implementation.md" },
        tracker: {
          kind: "github_project_v2",
          project_owner: "Alive24",
          project_owner_type: "user",
          project_number: 11,
          status_field: "Status",
          intake_state: "Failure Report",
          ready_destination: readyDestination,
        },
      },
    ],
  });
}

function handoff(): ImplementationHandoff {
  return implementationHandoffSchema.parse({
    schema_version: "failure-report/implementation-handoff/v1",
    handoff_id:
      "failure-report/implementation-handoff/sha256/" + "a".repeat(64),
    report: {
      report_id: "ckboost-56",
      issue: {
        repository: "Alive24/CKBoost",
        issue_number: 56,
        issue_url: "https://github.com/Alive24/CKBoost/issues/56",
      },
      workpad: {
        revision: 4,
        logical_session_id: "github-issue/Alive24/CKBoost/56/ckboost-56",
        entry_id: "github-issue/Alive24/CKBoost/56/ckboost-56/revision-4",
      },
    },
    target: {
      repository: "Alive24/CKBoost",
      revision: "b".repeat(40),
    },
    diagnostic_snapshot: {
      branch: "diagnostic/56-fix-sync",
      remote_ref: "refs/heads/diagnostic/56-fix-sync",
      remote_url:
        "https://github.com/Alive24/CKBoost/tree/diagnostic/56-fix-sync",
      head_revision: "b".repeat(40),
      reuse_policy: "diagnostic_snapshot_only",
    },
    diagnostic_completion_ids: ["completion-56"],
    evidence_refs: ["evidence-1"],
    contract: {
      goal: "Make sync failures observable and recoverable.",
      why_now: "The current failure blocks reliable edits.",
      scope_in: ["Preserve failed event identity."],
      scope_out: ["Do not redesign unrelated UI."],
      guardrails: ["Do not develop from the diagnostic branch."],
      required_outcomes: ["A failed sync can be retried safely."],
      verification: {
        automated: ["pnpm test"],
        uat: ["Retry one failed event."],
        context: [],
      },
      uat_required: true,
      residual_risks: [],
    },
    markdown: "# Canonical implementation handoff",
  });
}

const request = {
  report_id: "ckboost-56",
  repository: "Alive24/CKBoost",
  issue_number: 56,
  expected_workpad_revision: 4,
  expected_workpad_logical_session_id:
    "github-issue/Alive24/CKBoost/56/ckboost-56",
  expected_workpad_entry_id:
    "github-issue/Alive24/CKBoost/56/ckboost-56/revision-4",
  expected_target_revision: "b".repeat(40),
};

describe("handoff delivery policy and template", () => {
  it("parses one repository policy and rejects duplicate repositories or unsupported destinations", () => {
    const parsed = readHandoffDeliveryPolicy({
      FAILURE_REPORT_HANDOFF_DELIVERY_POLICY: JSON.stringify(policy("Todo")),
    });

    expect(
      findRepositoryHandoffDeliveryPolicy(parsed!, "alive24/ckboost")?.tracker
        .ready_destination,
    ).toBe("Todo");
    expect(() =>
      handoffDeliveryPolicySchema.parse({
        ...policy(),
        repositories: [
          ...policy().repositories,
          {
            ...policy().repositories[0],
            repository: "alive24/ckboost",
          },
        ],
      }),
    ).toThrow("unique");
    expect(() =>
      handoffDeliveryPolicySchema.parse({
        ...policy(),
        repositories: [
          {
            ...policy().repositories[0],
            tracker: {
              ...policy().repositories[0]!.tracker,
              ready_destination: "Human Review",
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("renders a deterministic human view and always appends canonical folded JSON", () => {
    const repositoryPolicy = policy("Todo").repositories[0]!;
    const first = prepareHandoffDelivery({
      handoff: handoff(),
      policy: repositoryPolicy,
      template,
    });
    const second = prepareHandoffDelivery({
      handoff: handoff(),
      policy: repositoryPolicy,
      template,
    });

    expect(first).toEqual(second);
    expect(first.comment_body).toContain(
      "Make sync failures observable and recoverable.",
    );
    expect(first.comment_body).toContain(
      "<summary>Canonical FailureReport handoff and delivery intent</summary>",
    );
    expect(first.comment_body).toContain('"state": "Todo"');
    expect(first.comment_body).not.toContain("Human Review");
  });

  it("rejects traversal, symlink escape, missing required variables, and reserved markers", async () => {
    const root = join(
      process.env.TMPDIR ?? "/tmp",
      `failure-report-template-${crypto.randomUUID()}`,
    );
    const outside = join(
      process.env.TMPDIR ?? "/tmp",
      `failure-report-outside-${crypto.randomUUID()}.md`,
    );
    await mkdir(join(root, "templates"), { recursive: true });
    await writeFile(join(root, "templates", "valid.md"), template);
    await writeFile(outside, template);
    await symlink(outside, join(root, "templates", "escape.md"));

    await expect(
      loadHandoffTemplate(root, "templates/valid.md"),
    ).resolves.toMatchObject({ content: template });
    await expect(
      loadHandoffTemplate(root, "templates/escape.md"),
    ).rejects.toThrow("inside");
    expect(() =>
      prepareHandoffDelivery({
        handoff: handoff(),
        policy: policy().repositories[0]!,
        template: "# Only {{goal}}",
      }),
    ).toThrow("missing required variables");
    expect(() =>
      prepareHandoffDelivery({
        handoff: handoff(),
        policy: policy().repositories[0]!,
        template:
          template + "\n<!-- failure-report-handoff-delivery/v1 malicious -->",
      }),
    ).toThrow("reserved");
  });
});

describe("configured tracker routing and delivery", () => {
  it("routes accepted intake only to Failure Report using deployment coordinates", async () => {
    const setIssueState = vi.fn().mockResolvedValue({
      item_id: "item-56",
      previous_state: "Backlog",
      state: "Failure Report",
    });
    const route = createFailureReportIntakeRouter({
      policy: policy(),
      tracker: { setIssueState },
    });

    await expect(
      route({ repository: "Alive24/CKBoost", issue_number: 56 }),
    ).resolves.toEqual({ status: "completed", state: "Failure Report" });
    expect(setIssueState).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "Alive24/CKBoost",
        issue_number: 56,
        state: "Failure Report",
      }),
    );
  });

  it("keeps tracker-free intake available when no repository policy is configured", async () => {
    const tracker = {
      setIssueState: vi.fn(),
    } satisfies GithubProjectTracker;
    const route = createFailureReportIntakeRouter({
      environment: {},
      tracker,
    });

    await expect(
      route({ repository: "Alive24/CKBoost", issue_number: 56 }),
    ).resolves.toEqual({ status: "not_configured" });
    expect(tracker.setIssueState).not.toHaveBeenCalled();
  });

  it("publishes one configured comment and moves only to Todo after tracker readback", async () => {
    const publishHandoffComment = vi.fn().mockResolvedValue({
      issue: {},
      comment_ref: "9001",
    });
    const gateway = {
      readIssue: vi.fn(),
      publishSharedContext: vi.fn(),
      publishHandoffComment,
      getWorkpadProducerConfiguration: vi.fn(),
    } as unknown as GithubIssueGateway;
    const setIssueState = vi.fn().mockResolvedValue({
      item_id: "item-56",
      previous_state: "Failure Report",
      state: "Todo",
    });
    const tracker = { setIssueState } satisfies GithubProjectTracker;
    const implementationHandoff = handoff();
    const renderer = vi.fn().mockResolvedValue({
      status: "completed",
      report_id: "ckboost-56",
      implementation_handoff: implementationHandoff,
    });
    const deliver = createDiagnosticHandoffDelivery({
      applicationRoot: "/unused",
      gateway,
      policy: policy("Todo"),
      renderer,
      templateLoader: vi.fn().mockResolvedValue({
        content: template,
        canonical_path: "/unused/template.md",
      }),
      tracker,
    });

    const result = await deliver(request);

    expect(result).toMatchObject({
      status: "completed",
      implementation_handoff: implementationHandoff,
      handoff_delivery: {
        comment: { ref: "9001" },
        tracker: { state: "Todo" },
      },
    });
    expect(publishHandoffComment).toHaveBeenCalledOnce();
    expect(renderer).toHaveBeenCalledTimes(2);
    expect(setIssueState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "Todo",
        allowed_previous_states: [
          null,
          "Failure Report",
          "Need Human Input",
          "Todo",
        ],
      }),
    );
    expect(JSON.stringify(setIssueState.mock.calls)).not.toContain(
      "Human Review",
    );
  });

  it("does not move the tracker when the managed workpad changes after comment publication", async () => {
    const implementationHandoff = handoff();
    const publishHandoffComment = vi.fn().mockResolvedValue({
      issue: {},
      comment_ref: "9001",
    });
    const gateway = {
      publishHandoffComment,
    } as unknown as GithubIssueGateway;
    const tracker = {
      setIssueState: vi.fn(),
    } satisfies GithubProjectTracker;
    const renderer = vi
      .fn()
      .mockResolvedValueOnce({
        status: "completed",
        report_id: "ckboost-56",
        implementation_handoff: implementationHandoff,
      })
      .mockResolvedValueOnce({
        status: "needs_input",
        report_id: "ckboost-56",
        reason: "stale revision",
      });
    const deliver = createDiagnosticHandoffDelivery({
      applicationRoot: "/unused",
      gateway,
      policy: policy("Todo"),
      renderer,
      templateLoader: vi.fn().mockResolvedValue({
        content: template,
        canonical_path: "/unused/template.md",
      }),
      tracker,
    });

    await expect(deliver(request)).resolves.toMatchObject({
      status: "needs_input",
      reason: expect.stringContaining("changed before tracker delivery"),
    });
    expect(publishHandoffComment).toHaveBeenCalledOnce();
    expect(tracker.setIssueState).not.toHaveBeenCalled();
  });

  it("fails closed before side effects when no repository policy exists", async () => {
    const tracker = {
      setIssueState: vi.fn(),
    } satisfies GithubProjectTracker;
    const deliver = createDiagnosticHandoffDelivery({
      environment: {},
      tracker,
    });

    await expect(deliver(request)).resolves.toMatchObject({
      status: "needs_input",
      reason: expect.stringContaining("FAILURE_REPORT_HANDOFF_DELIVERY_POLICY"),
    });
    expect(tracker.setIssueState).not.toHaveBeenCalled();
  });
});
