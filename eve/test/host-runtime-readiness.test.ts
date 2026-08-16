import { describe, expect, it, vi } from "vitest";

import { preflightHostRuntime } from "../agent/lib/host-runtime-readiness.js";
import {
  FailureReportRuntimeError,
  logRuntimeFailure,
  runtimeFailureReason,
} from "../agent/lib/runtime-failures.js";

const policy = {
  schema_version: "failure-report/handoff-delivery-policy/v1" as const,
  repositories: [
    {
      repository: "Alive24/CKBoost",
      template: { path: ".shea/template/failureReport/custom.md" },
      tracker: null,
    },
  ],
};

function targetShea() {
  return {
    canonical_checkout: "/target",
    shea_root: "/target/.shea",
    worktree_root: "/target/.shea/worktrees/failureReport",
    prompts: { intake: "intake", synthesis: "synthesis" },
    handoff_template_path:
      "/target/.shea/template/failureReport/implementation.md",
  };
}

describe("host runtime readiness", () => {
  it("composes workspace, missing-only assets, write authority, and configured template checks", async () => {
    const preflight = vi.fn().mockResolvedValue({
      canonical_path: "/target",
      canonical_remote: "https://github.com/Alive24/CKBoost.git",
    });
    const prepare = vi.fn().mockResolvedValue(targetShea());
    const verify = vi.fn().mockResolvedValue(undefined);
    const loadTemplate = vi.fn().mockResolvedValue({
      content: "# Handoff",
      canonical_path: "/target/.shea/template/failureReport/custom.md",
    });

    await expect(
      preflightHostRuntime({
        policy,
        source_resolver: { preflight },
        prepare_target_shea: prepare,
        verify_write_authority: verify,
        template_loader: loadTemplate,
      }),
    ).resolves.toEqual({ status: "ready", delivery_policy: "configured" });
    expect(preflight).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith({ canonicalCheckout: "/target" });
    expect(verify).toHaveBeenCalledWith(
      "/target/.shea/worktrees/failureReport",
    );
    expect(loadTemplate).toHaveBeenCalledWith(
      "/target",
      ".shea/template/failureReport/custom.md",
    );
  });

  it("does not guess repository or revision context when policy does not match the bound origin", async () => {
    const loadTemplate = vi.fn();

    await expect(
      preflightHostRuntime({
        policy,
        source_resolver: {
          preflight: vi.fn().mockResolvedValue({
            canonical_path: "/target",
            canonical_remote: "git@github.com:Alive24/Other.git",
          }),
        },
        prepare_target_shea: vi.fn().mockResolvedValue(targetShea()),
        verify_write_authority: vi.fn().mockResolvedValue(undefined),
        template_loader: loadTemplate,
      }),
    ).resolves.toEqual({
      status: "ready",
      delivery_policy: "not_configured",
    });
    expect(loadTemplate).not.toHaveBeenCalled();
  });

  it("classifies invalid policy before Eve accepts work", async () => {
    await expect(
      preflightHostRuntime({
        environment: {
          FAILURE_REPORT_HANDOFF_DELIVERY_POLICY: "{not-json",
        },
        source_resolver: {
          preflight: vi.fn().mockResolvedValue({
            canonical_path: "/target",
            canonical_remote: "https://github.com/Alive24/CKBoost.git",
          }),
        },
        prepare_target_shea: vi.fn().mockResolvedValue(targetShea()),
        verify_write_authority: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toMatchObject({ category: "delivery_policy_invalid" });
  });

  it("logs only the boundary and redacted category", () => {
    const entries: string[] = [];
    const error = new FailureReportRuntimeError(
      "git_fetch_failed",
      "token=secret path=/private/checkout endpoint=https://example.invalid",
    );

    logRuntimeFailure("startup", error, "target_workspace_invalid", (entry) =>
      entries.push(entry),
    );

    expect(entries).toEqual([
      JSON.stringify({
        event: "failure-report.runtime-failure",
        boundary: "startup",
        category: "git_fetch_failed",
      }),
    ]);
    expect(entries[0]).not.toContain("secret");
    expect(runtimeFailureReason(error, "target_workspace_invalid")).toContain(
      "host Git authentication",
    );
  });
});
