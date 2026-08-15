import { describe, expect, it } from "vitest";

import {
  CaptureError,
  validateCanonicalSpans,
} from "../scripts/root-codex-trace-capture.mjs";

const revision = "a".repeat(40);
const traceId = "f".repeat(32);

describe("real capture external-parent validation", () => {
  it("preserves an unexported parent edge without counting it as internal hierarchy", () => {
    const externalParentId = "9".repeat(16);
    const records = [
      span("1", "", "ai.eve.turn", "agent_step"),
      span("2", "1", "execute_tool", "execute_tool"),
      span("3", "2", "invoke_agent", "invoke_agent", {
        "gen_ai.agent.name": "codex",
      }),
      span("4", externalParentId, "observer-boundary"),
      span("5", "4", "observer-descendant"),
    ];

    const canonical = validateCanonicalSpans(records, revision);

    expect(canonical).toMatchObject({
      internal_parent_edge_count: 3,
      external_parent_edge_count: 1,
      maximum_internal_depth: 3,
    });
    const projected = canonical.body
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    expect(
      projected.find((record) => record.span_id === "4".repeat(16)),
    ).toMatchObject({
      parent_span_id: externalParentId,
    });
  });

  it("does not let an external boundary manufacture the required depth", () => {
    const records = [
      span("1", "9", "ai.eve.turn", "agent_step"),
      span("2", "1", "execute_tool", "execute_tool"),
      span("3", "", "invoke_agent", "invoke_agent", {
        "gen_ai.agent.name": "codex",
      }),
    ];

    expect(() => validateCanonicalSpans(records, revision)).toThrowError(
      new CaptureError("missing_multilevel_hierarchy"),
    );
  });

  it("still rejects cycles among exported spans", () => {
    const records = [
      span("1", "3", "ai.eve.turn", "agent_step"),
      span("2", "1", "execute_tool", "execute_tool"),
      span("3", "2", "invoke_agent", "invoke_agent", {
        "gen_ai.agent.name": "codex",
      }),
    ];

    expect(() => validateCanonicalSpans(records, revision)).toThrowError(
      new CaptureError("parent_cycle"),
    );
  });
});

function span(
  id: string,
  parent: string,
  name: string,
  operation?: string,
  extraAttributes: Record<string, string> = {},
) {
  return {
    trace_id: traceId,
    span_id: id.length === 1 ? id.repeat(16) : id,
    parent_span_id: parent.length === 1 ? parent.repeat(16) : parent,
    trace_state: "",
    name,
    kind: "SPAN_KIND_INTERNAL",
    start_time: "2026-08-15T00:00:00.000000000Z",
    end_time: "2026-08-15T00:00:01.000000000Z",
    status: { code: "STATUS_CODE_OK", message: "" },
    resource: {
      attributes: {
        "service.name": "failure-report-eve-root",
        "service.version": revision,
      },
    },
    scope: { name: "external-parent-test", version: "1" },
    attributes: {
      ...(operation ? { "gen_ai.operation.name": operation } : {}),
      ...extraAttributes,
    },
    events: [],
    links: [],
  };
}
