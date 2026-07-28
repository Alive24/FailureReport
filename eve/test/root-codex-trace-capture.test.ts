import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CaptureError,
  LoopbackOtlpCollector,
  assertLoopbackEndpoint,
  assertSafeReceipt,
  atomicallyFinalizeCapture,
  createCaptureReceipt,
  decodeOtlpTracePayload,
  loadCaptureConfiguration,
  parseCaptureEnvironment,
  prepareContainedOutputDirectory,
  repositoryFromRemote,
  runRealRootCodexTraceCapture,
  validateCanonicalSpans,
} from "../scripts/root-codex-trace-capture.mjs";

const temporaryDirectories: string[] = [];
const sourceRevision = "a".repeat(40);
const fixtureRevision = "b".repeat(40);

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) {
    await import("node:fs/promises").then(({ rm }) =>
      rm(path, { recursive: true, force: true }),
    );
  }
});

describe("real Root-to-Codex trace capture configuration", () => {
  it("requires every operator-owned immutable input", () => {
    expect(() => parseCaptureEnvironment({})).toThrowError(
      captureError("missing_runtime_input"),
    );
    expect(() =>
      parseCaptureEnvironment(
        validEnvironment({
          FAILURE_REPORT_TRACE_FIXTURE_REVISION: "main",
        }),
      ),
    ).toThrowError(captureError("fixture_revision_invalid"));
    expect(() =>
      parseCaptureEnvironment(
        validEnvironment({
          FAILURE_REPORT_TRACE_EXPECTED_SOURCE_REVISION: "HEAD",
        }),
      ),
    ).toThrowError(captureError("source_revision_invalid"));
  });

  it("rejects tokens, credentials, DNS names, and non-loopback endpoints", () => {
    for (const endpoint of [
      "http://localhost:8799",
      "http://192.168.1.4:8799",
      "https://127.0.0.1:8799",
      "http://user:secret@127.0.0.1:8799",
      "http://127.0.0.1:8799/redirect",
    ]) {
      expect(() => assertLoopbackEndpoint(endpoint)).toThrowError(
        captureError("unsafe_trace_endpoint"),
      );
    }
    expect(() =>
      parseCaptureEnvironment(
        validEnvironment({ CATALYST_OTLP_TOKEN: "secret" }),
      ),
    ).toThrowError(captureError("trace_token_forbidden"));
    expect(() =>
      parseCaptureEnvironment(
        validEnvironment({
          CATALYST_OTLP_ENDPOINT: "http://collector.example:8799",
        }),
      ),
    ).toThrowError(captureError("unsafe_trace_endpoint"));
    expect(() =>
      parseCaptureEnvironment(
        validEnvironment({
          CATALYST_OTLP_ENDPOINT: "http://127.0.0.1:8799",
        }),
      ),
    ).not.toThrow();
  });

  it("accepts only canonical GitHub repository remotes", () => {
    expect(repositoryFromRemote("git@github.com:Alive24/Fixture.git")).toBe(
      "Alive24/Fixture",
    );
    expect(repositoryFromRemote("https://github.com/Alive24/Fixture.git")).toBe(
      "Alive24/Fixture",
    );
    expect(() =>
      repositoryFromRemote("https://token@github.com/Alive24/Fixture.git"),
    ).toThrowError(captureError("target_repository_mismatch"));
    expect(() =>
      repositoryFromRemote("https://git@github.com/Alive24/Fixture.git"),
    ).toThrowError(captureError("target_repository_mismatch"));
  });

  it("contains output below ignored Halo storage and refuses existing data", async () => {
    const repository = await temporaryDirectory();
    const contained = join(
      repository,
      ".shea",
      "artifacts",
      "halo",
      "candidate-run",
    );
    const prepared = await prepareContainedOutputDirectory(
      repository,
      contained,
    );
    expect(prepared).toBe(
      await import("node:fs/promises").then(({ realpath }) =>
        realpath(contained),
      ),
    );
    expect((await lstat(prepared)).mode & 0o777).toBe(0o700);

    await writeFile(join(prepared, "old.jsonl"), "{}\n", "utf8");
    await expect(
      prepareContainedOutputDirectory(repository, contained),
    ).rejects.toThrowError(captureError("output_directory_not_empty"));
    await expect(
      prepareContainedOutputDirectory(repository, join(repository, "escape")),
    ).rejects.toThrowError(captureError("output_directory_escape"));
  });

  it("binds clean source and fixture checkouts to their exact revisions and repository", async () => {
    const repository = await temporaryDirectory();
    const target = await temporaryDirectory();
    const output = join(
      repository,
      ".shea",
      "artifacts",
      "halo",
      "candidate-run",
    );
    const environment = validEnvironment({
      FAILURE_REPORT_TRACE_TARGET_CHECKOUT: target,
      FAILURE_REPORT_TRACE_OUTPUT_DIRECTORY: output,
    });
    const runGit = fakeGit({
      repository,
      target,
    });

    await expect(
      loadCaptureConfiguration({
        repositoryRoot: repository,
        environment,
        runGit,
      }),
    ).resolves.toMatchObject({
      repository_root: repository,
      target_checkout: target,
      expected_source_revision: sourceRevision,
    });
  });

  it.each([
    [{ sourceHead: fixtureRevision }, "source_checkout_mismatch"],
    [{ targetHead: sourceRevision }, "target_checkout_mismatch"],
    [{ sourceStatus: " M package.json" }, "source_checkout_mismatch"],
    [{ targetStatus: "?? artifact" }, "target_checkout_mismatch"],
    [
      { targetRemote: "https://github.com/Other/Fixture.git" },
      "target_repository_mismatch",
    ],
    [{ ignored: false }, "output_directory_not_ignored"],
  ])(
    "rejects stale, dirty, mismatched, or public checkout state",
    async (git, code) => {
      const repository = await temporaryDirectory();
      const target = await temporaryDirectory();
      await expect(
        loadCaptureConfiguration({
          repositoryRoot: repository,
          environment: validEnvironment({
            FAILURE_REPORT_TRACE_TARGET_CHECKOUT: target,
            FAILURE_REPORT_TRACE_OUTPUT_DIRECTORY: join(
              repository,
              ".shea",
              "artifacts",
              "halo",
              "candidate-run",
            ),
          }),
          runGit: fakeGit({ repository, target, ...git }),
        }),
      ).rejects.toThrowError(captureError(code));
    },
  );

  it("rejects a symlink anywhere in the output containment chain", async () => {
    const repository = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await mkdir(join(repository, ".shea"), { recursive: true });
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(outside, join(repository, ".shea", "artifacts")),
    );
    await expect(
      prepareContainedOutputDirectory(
        repository,
        join(repository, ".shea", "artifacts", "halo", "run"),
      ),
    ).rejects.toThrowError(captureError("output_directory_symlink"));
  });
});

describe("OTLP/JSON canonical projection", () => {
  it("accepts only credential-free loopback OTLP/JSON requests", async () => {
    const collector = new LoopbackOtlpCollector({ exportQuietMs: 0 });
    const endpoint = await collector.start();
    try {
      const accepted = await fetch(`${endpoint}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpPayload([otlpSpan()])),
        redirect: "manual",
      });
      expect(accepted.status).toBe(200);
      expect(collector.records).toHaveLength(1);

      const rejected = await fetch(`${endpoint}/v1/traces`, {
        method: "POST",
        headers: {
          authorization: "Bearer forbidden",
          "content-type": "application/json",
        },
        body: JSON.stringify(otlpPayload([otlpSpan()])),
        redirect: "manual",
      });
      expect(rejected.status).toBe(400);
      await expect(
        collector.waitForRequiredOperations(new AbortController().signal),
      ).rejects.toThrowError(captureError("otlp_authorization_rejected"));
    } finally {
      await collector.close();
    }
  });

  it("marks malformed local OTLP as a terminal rejection", async () => {
    const collector = new LoopbackOtlpCollector({ exportQuietMs: 0 });
    const endpoint = await collector.start();
    try {
      const response = await fetch(`${endpoint}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
        redirect: "manual",
      });
      expect(response.status).toBe(400);
      await expect(
        collector.waitForRequiredOperations(new AbortController().signal),
      ).rejects.toThrowError(captureError("otlp_malformed_payload"));
    } finally {
      await collector.close();
    }
  });

  it("preserves native identity, timing, resource/scope, attributes, events, links, and status", () => {
    const records = decodeOtlpTracePayload(
      Buffer.from(
        JSON.stringify(
          otlpPayload([
            otlpSpan({
              spanId: "1".repeat(16),
              name: "ai.eve.turn",
              attributes: attributes({
                "gen_ai.operation.name": "agent_step",
                enabled: true,
                attempts: 2,
              }),
              events: [
                {
                  name: "checkpoint",
                  timeUnixNano: "1785196800500000000",
                  attributes: attributes({ phase: "ready" }),
                  droppedAttributesCount: 0,
                },
              ],
              links: [
                {
                  traceId: "c".repeat(32),
                  spanId: "d".repeat(16),
                  traceState: "vendor=value",
                  attributes: attributes({ relation: "follows" }),
                  droppedAttributesCount: 0,
                },
              ],
              status: { code: 2, message: "classified" },
            }),
          ]),
        ),
      ),
    );

    expect(records).toEqual([
      {
        trace_id: "f".repeat(32),
        span_id: "1".repeat(16),
        parent_span_id: "",
        trace_state: "state=value",
        name: "ai.eve.turn",
        kind: "SPAN_KIND_INTERNAL",
        start_time: "2026-07-28T00:00:00.000000000Z",
        end_time: "2026-07-28T00:00:01.000000000Z",
        status: {
          code: "STATUS_CODE_ERROR",
          message: "classified",
        },
        resource: {
          attributes: {
            "service.name": "failure-report-eve-root",
            "service.version": sourceRevision,
          },
        },
        scope: { name: "@inference/tracing.eve", version: "0.1.8" },
        attributes: {
          "gen_ai.operation.name": "agent_step",
          enabled: true,
          attempts: 2,
        },
        events: [
          {
            name: "checkpoint",
            timestamp: "2026-07-28T00:00:00.500000000Z",
            attributes: { phase: "ready" },
          },
        ],
        links: [
          {
            trace_id: "c".repeat(32),
            span_id: "d".repeat(16),
            trace_state: "vendor=value",
            attributes: { relation: "follows" },
          },
        ],
      },
    ]);
  });

  it.each([
    [{ resourceSpans: "invalid" }, "otlp_malformed_payload"],
    [
      otlpPayload([{ ...otlpSpan(), traceId: "invalid" }]),
      "otlp_malformed_trace_id",
    ],
    [
      otlpPayload([
        {
          ...otlpSpan(),
          droppedEventsCount: 1,
        },
      ]),
      "otlp_dropped_data",
    ],
  ])("rejects malformed or lossy OTLP payloads", (payload, code) => {
    expect(() =>
      decodeOtlpTracePayload(Buffer.from(JSON.stringify(payload))),
    ).toThrowError(captureError(code));
  });
});

describe("canonical dataset validation and receipt", () => {
  it("accepts a complete native Eve Root/tool/delegated-Codex hierarchy", async () => {
    const records = canonicalHierarchy();
    const canonical = validateCanonicalSpans(records, sourceRevision);
    expect(canonical).toMatchObject({
      span_count: 3,
      trace_count: 1,
      parented_span_count: 2,
      maximum_depth: 3,
      semantic_operation_counts: {
        eve_root_turn: 1,
        eve_tool: 1,
        delegated_codex: 1,
      },
    });
    const receipt = createCaptureReceipt({
      canonical,
      fixture: {
        repository: "Alive24/Fixture",
        issue_number: 123,
        revision: fixtureRevision,
      },
      revision: sourceRevision,
    });
    expect(() => assertSafeReceipt(receipt)).not.toThrow();
    expect(JSON.stringify(receipt)).not.toMatch(
      /prompt|response|argument|result|endpoint|credential|token|host|path/i,
    );

    const output = await temporaryDirectory();
    await chmod(output, 0o700);
    await atomicallyFinalizeCapture(output, canonical.body, receipt);
    const jsonl = await readFile(join(output, "traces.jsonl"), "utf8");
    const persistedReceipt = JSON.parse(
      await readFile(join(output, "receipt.json"), "utf8"),
    );
    expect(jsonl.trim().split("\n")).toHaveLength(3);
    expect(persistedReceipt).toEqual(receipt);
    expect((await lstat(join(output, "traces.jsonl"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it.each([
    [[], "empty_trace_set"],
    [
      [...canonicalHierarchy(), { ...canonicalHierarchy()[0] }],
      "duplicate_span_identity",
    ],
    [
      canonicalHierarchy().map((span, index) =>
        index === 1 ? { ...span, parent_span_id: "9".repeat(16) } : span,
      ),
      "missing_parent_span",
    ],
    [
      canonicalHierarchy().map((span, index) =>
        index === 1
          ? {
              ...span,
              resource: {
                attributes: {
                  ...span.resource.attributes,
                  "service.version": fixtureRevision,
                },
              },
            }
          : span,
      ),
      "mixed_service_version",
    ],
    [
      canonicalHierarchy().filter(
        (span) => span.attributes["gen_ai.operation.name"] !== "invoke_agent",
      ),
      "missing_multilevel_hierarchy",
    ],
    [
      canonicalHierarchy().map((span) => ({
        ...span,
        name: span.name === "execute_tool" ? "other" : span.name,
        attributes: {
          ...span.attributes,
          "gen_ai.operation.name":
            span.attributes["gen_ai.operation.name"] === "execute_tool"
              ? "other"
              : span.attributes["gen_ai.operation.name"],
        },
      })),
      "missing_eve_tool_operation",
    ],
  ])("fails closed for invalid evidence", (records, code) => {
    expect(() => validateCanonicalSpans(records, sourceRevision)).toThrowError(
      captureError(code),
    );
  });

  it("rejects any expansion of the bounded receipt", () => {
    expect(() =>
      assertSafeReceipt({
        ...safeReceipt(),
        endpoint: "http://127.0.0.1:8799",
      }),
    ).toThrowError(captureError("receipt_forbidden_field"));
    expect(() =>
      assertSafeReceipt({
        ...safeReceipt(),
        counts: {
          ...safeReceipt().counts,
          raw_result: 1,
        },
      }),
    ).toThrowError(captureError("receipt_forbidden_field"));
  });

  it("does not confuse a safe fixture name with a forbidden receipt field", () => {
    expect(() =>
      assertSafeReceipt({
        ...safeReceipt(),
        fixture: {
          ...safeReceipt().fixture,
          repository: "GhostOrg/token-tools",
        },
      }),
    ).not.toThrow();
  });
});

describe("capture lifecycle", () => {
  it("cleans up the runtime and collector after successful finalization", async () => {
    const output = await temporaryDirectory();
    const lifecycle: string[] = [];
    const receipt = await runRealRootCodexTraceCapture(
      captureConfiguration(output),
      fakeLifecycle({
        lifecycle,
        records: canonicalHierarchy(),
      }),
    );

    expect(receipt.status_classification).toBe("complete");
    expect(lifecycle).toEqual([
      "collector:start",
      "runtime:start",
      "runtime:ready",
      "root:complete",
      "collector:flush",
      "runtime:stop",
      "collector:close",
    ]);
  });

  it.each([
    [
      "readiness_timeout",
      {
        readinessTimeoutMs: 5,
        waitForReadiness: () => new Promise(() => undefined),
      },
    ],
    [
      "root_flow_failed",
      {
        invokeRootFlow: async () => {
          throw new CaptureError("root_flow_failed");
        },
      },
    ],
    [
      "codex_flow_failed",
      {
        invokeRootFlow: async () => {
          throw new CaptureError("codex_flow_failed");
        },
      },
    ],
    [
      "otlp_transport_rejected",
      {
        waitForRequiredOperations: async () => {
          throw new CaptureError("otlp_transport_rejected");
        },
      },
    ],
    [
      "export_flush_timeout",
      {
        waitForRequiredOperations: async () => {
          throw new CaptureError("export_flush_timeout");
        },
      },
    ],
    [
      "capture_interrupted",
      {
        invokeRootFlow: async () => {
          throw new CaptureError("capture_interrupted");
        },
      },
    ],
  ])("cleans both boundaries after %s", async (code, overrides) => {
    const output = await temporaryDirectory();
    const lifecycle: string[] = [];
    await expect(
      runRealRootCodexTraceCapture(
        captureConfiguration(output),
        fakeLifecycle({
          lifecycle,
          records: canonicalHierarchy(),
          ...overrides,
        }),
      ),
    ).rejects.toThrowError(captureError(code));
    expect(lifecycle).toContain("runtime:stop");
    expect(lifecycle.at(-1)).toBe("collector:close");
    await expect(readFile(join(output, "traces.jsonl"))).rejects.toThrow();
  });
});

function validEnvironment(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    FAILURE_REPORT_TRACE_FIXTURE_REPOSITORY: "Alive24/Fixture",
    FAILURE_REPORT_TRACE_FIXTURE_ISSUE_NUMBER: "123",
    FAILURE_REPORT_TRACE_FIXTURE_REVISION: fixtureRevision,
    FAILURE_REPORT_TRACE_TARGET_CHECKOUT: "/tmp/fixture",
    FAILURE_REPORT_TRACE_EXPECTED_SOURCE_REVISION: sourceRevision,
    FAILURE_REPORT_TRACE_OUTPUT_DIRECTORY: "/tmp/output",
    ...overrides,
  };
}

function fakeGit({
  repository,
  target,
  sourceHead = sourceRevision,
  targetHead = fixtureRevision,
  sourceStatus = "",
  targetStatus = "",
  targetRemote = "https://github.com/Alive24/Fixture.git",
  ignored = true,
}: {
  repository: string;
  target: string;
  sourceHead?: string;
  targetHead?: string;
  sourceStatus?: string;
  targetStatus?: string;
  targetRemote?: string;
  ignored?: boolean;
}) {
  return async (cwd: string, arguments_: string[]) => {
    if (arguments_[0] === "rev-parse" && arguments_[1] === "--show-toplevel") {
      return cwd;
    }
    if (arguments_[0] === "rev-parse" && arguments_[1] === "HEAD") {
      return cwd === repository ? sourceHead : targetHead;
    }
    if (arguments_[0] === "status") {
      return cwd === repository ? sourceStatus : targetStatus;
    }
    if (arguments_[0] === "remote") {
      return targetRemote;
    }
    if (arguments_[0] === "check-ignore") {
      if (!ignored) {
        throw new Error("not ignored");
      }
      return "";
    }
    throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
  };
}

function attributes(
  values: Record<string, string | number | boolean>,
): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value:
      typeof value === "string"
        ? { stringValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : { intValue: value },
  }));
}

function otlpPayload(spans: unknown[]) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributes({
            "service.name": "failure-report-eve-root",
            "service.version": sourceRevision,
          }),
          droppedAttributesCount: 0,
        },
        scopeSpans: [
          {
            scope: {
              name: "@inference/tracing.eve",
              version: "0.1.8",
            },
            spans,
          },
        ],
      },
    ],
  };
}

function otlpSpan(overrides: Record<string, unknown> = {}) {
  return {
    traceId: "f".repeat(32),
    spanId: "1".repeat(16),
    traceState: "state=value",
    name: "span",
    kind: 1,
    startTimeUnixNano: "1785196800000000000",
    endTimeUnixNano: "1785196801000000000",
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    status: { code: 1, message: "" },
    links: [],
    droppedLinksCount: 0,
    ...overrides,
  };
}

function canonicalHierarchy() {
  const traceId = "f".repeat(32);
  const base = {
    trace_id: traceId,
    trace_state: "",
    kind: "SPAN_KIND_INTERNAL",
    start_time: "2026-07-28T00:00:00.000000000Z",
    end_time: "2026-07-28T00:00:01.000000000Z",
    status: { code: "STATUS_CODE_OK", message: "" },
    resource: {
      attributes: {
        "service.name": "failure-report-eve-root",
        "service.version": sourceRevision,
      },
    },
    scope: { name: "@inference/tracing.eve", version: "0.1.8" },
    events: [],
    links: [],
  };
  return [
    {
      ...base,
      span_id: "1".repeat(16),
      parent_span_id: "",
      name: "ai.eve.turn",
      attributes: { "gen_ai.operation.name": "agent_step" },
    },
    {
      ...base,
      span_id: "2".repeat(16),
      parent_span_id: "1".repeat(16),
      name: "execute_tool",
      attributes: { "gen_ai.operation.name": "execute_tool" },
    },
    {
      ...base,
      span_id: "3".repeat(16),
      parent_span_id: "2".repeat(16),
      name: "invoke_agent",
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "codex",
      },
    },
  ];
}

function captureConfiguration(output: string) {
  return {
    repository_root: "/candidate",
    target_checkout: "/fixture",
    output_directory: output,
    expected_source_revision: sourceRevision,
    fixture: {
      repository: "Alive24/Fixture",
      issue_number: 123,
      revision: fixtureRevision,
    },
  };
}

function fakeLifecycle({
  lifecycle,
  records,
  waitForReadiness,
  invokeRootFlow,
  waitForRequiredOperations,
  readinessTimeoutMs,
}: {
  lifecycle: string[];
  records: ReturnType<typeof canonicalHierarchy>;
  waitForReadiness?: () => Promise<void>;
  invokeRootFlow?: () => Promise<void>;
  waitForRequiredOperations?: () => Promise<void>;
  readinessTimeoutMs?: number;
}) {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null });
  const collector = {
    records,
    async start() {
      lifecycle.push("collector:start");
      return "http://127.0.0.1:43210";
    },
    async waitForRequiredOperations() {
      lifecycle.push("collector:flush");
      await waitForRequiredOperations?.();
    },
    async close() {
      lifecycle.push("collector:close");
    },
  };
  return {
    collector,
    readinessTimeoutMs,
    async startRuntime() {
      lifecycle.push("runtime:start");
      return child;
    },
    async waitForReadiness() {
      lifecycle.push("runtime:ready");
      await waitForReadiness?.();
    },
    async invokeRootFlow() {
      lifecycle.push("root:complete");
      await invokeRootFlow?.();
    },
    async stopRuntime() {
      lifecycle.push("runtime:stop");
      Object.assign(child, { exitCode: 0 });
    },
  };
}

function safeReceipt() {
  return {
    schema_version: "failure-report/root-codex-trace-capture-receipt/v1",
    revision: sourceRevision,
    digest: `sha256:${"c".repeat(64)}`,
    counts: {
      spans: 3,
      traces: 1,
      parented_spans: 2,
      maximum_depth: 3,
    },
    semantic_operation_counts: {
      eve_root_turn: 1,
      eve_tool: 1,
      delegated_codex: 1,
    },
    status_classification: "complete",
    fixture: {
      repository: "Alive24/Fixture",
      issue_number: 123,
      revision: fixtureRevision,
    },
  };
}

function captureError(code: string) {
  return expect.objectContaining({ name: "CaptureError", code });
}

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "failure-report-trace-test-"));
  temporaryDirectories.push(path);
  return realpath(resolve(path));
}
