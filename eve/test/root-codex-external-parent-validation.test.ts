import { describe, expect, it } from "vitest";

import {
  CaptureError,
  validateCanonicalSpans,
} from "../scripts/root-codex-trace-capture.mjs";

const revision = "a".repeat(40);
const traceId = "1".repeat(32);

function span(
  spanId: string,
  parentSpanId: string,
  name: string,
  operation?: string,
) {
  return {
    trace_id: traceId,
    span_id: spanId.repeat(16),
    parent_span_id: parentSpanId ? parentSpanId.repeat(16) : "",
    trace_state: "",
    name,
    kind: "SPAN_KIND_INTERNAL",
    start_time: "2026-01-01T00:00:00.000000000Z",
    end_time: "2026-01-01T00:00:01.000000000Z",
    status: { code: "STATUS_CODE_OK", message: "" },
    resource: { attributes: { "service.version": revision } },
    scope: { name: "neutral-test", version: "" },
    attributes: {
      ...(operation ? { "gen_ai.operation.name": operation } : {}),
      ...(operation === "invoke_agent" ? { "agent.name": "codex" } : {}),
    },
  };
}

function completeHierarchy() {
  return [
    span("1", "", "ai.eve.turn"),
    span("2", "1", "execute_tool", "execute_tool"),
    span("3", "2", "invoke_agent", "invoke_agent"),
  ];
}

describe("canonical external-parent boundaries", () => {
  it("retains a complete in-dataset hierarchy when another span's parent was not exported", () => {
    const result = validateCanonicalSpans(
      [...completeHierarchy(), span("4", "9", "external-child")],
      revision,
    );

    expect(result).toMatchObject({
      span_count: 4,
      parented_span_count: 3,
      external_parent_span_count: 1,
      maximum_depth: 3,
    });
  });

  it("does not count an absent parent edge as verified multilevel hierarchy", () => {
    const records = [
      span("1", "9", "ai.eve.turn"),
      span("2", "1", "execute_tool", "execute_tool"),
      span("3", "", "invoke_agent", "invoke_agent"),
    ];

    expect(() => validateCanonicalSpans(records, revision)).toThrowError(
      new CaptureError("missing_parent_span"),
    );
  });

  it("continues to reject cycles", () => {
    const records = completeHierarchy();
    records[0] = span("1", "3", "ai.eve.turn");

    expect(() => validateCanonicalSpans(records, revision)).toThrowError(
      new CaptureError("parent_cycle"),
    );
  });
});
