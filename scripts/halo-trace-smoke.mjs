#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const repositoryRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const artifactPath = join(
  repositoryRoot,
  ".shea/artifacts/halo/traces/failure-report-trace-smoke.jsonl",
);
const endpointBase = (
  process.env.CATALYST_OTLP_ENDPOINT ||
  process.env.HALO_TRACE_OTLP_ENDPOINT ||
  "http://127.0.0.1:8799"
).replace(/\/+$/, "");
const otlpEndpoint = endpointBase.endsWith("/v1/traces")
  ? endpointBase
  : `${endpointBase}/v1/traces`;

process.env.CATALYST_OTLP_ENDPOINT = endpointBase;
process.env.CATALYST_SERVICE_NAME ??= "failure-report-eve-root";
process.env.CATALYST_SERVICE_VERSION ??= "halo-issue-26-trace-smoke";

async function main() {
  await assertNativeInstrumentationFile();

const jsonlExporter = new AtomicJsonlSpanExporter(artifactPath);
const otlpExporter = new StrictExporter(
  new OTLPTraceExporter({
    url: otlpEndpoint,
    headers: process.env.CATALYST_OTLP_TOKEN
      ? { authorization: `Bearer ${process.env.CATALYST_OTLP_TOKEN}` }
      : undefined,
  }),
  `OTLP export to ${otlpEndpoint}`,
);
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: "failure-report-eve-root",
    "service.name": "failure-report-eve-root",
    "service.version": process.env.CATALYST_SERVICE_VERSION,
    "deployment.environment": process.env.NODE_ENV ?? "test",
    "telemetry.sdk.language": "nodejs",
    "failure_report.trace_guide.url":
      "https://docs.inference.net/integrations/traces/eve.md",
    "failure_report.trace_guide.sha256":
      "4cb9dcf2e3537f4f1cb7be1644bfb13d07e25754baf8c25cad335cdfd10a5c2e",
  }),
  spanProcessors: [
    new SimpleSpanProcessor(new MultiSpanExporter([jsonlExporter, otlpExporter])),
  ],
});

provider.register();

const tracer = trace.getTracer("failure-report-halo-smoke", "0.1.0");

try {
  await captureRepresentativeFailureReportFlow(tracer);
  await provider.forceFlush();
  await provider.shutdown();
  await verifyCanonicalJsonl(artifactPath);
  console.log(
    JSON.stringify(
      {
        artifact: artifactPath,
        otlp_endpoint: otlpEndpoint,
        spans: jsonlExporter.exportedSpanCount,
      },
      null,
      2,
    ),
  );
} catch (error) {
  try {
    await provider.shutdown();
  } catch {
    // Preserve the original export/capture failure.
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
}

async function assertNativeInstrumentationFile() {
  const instrumentationPath = join(repositoryRoot, "eve/agent/instrumentation.ts");
  const contents = await readFile(instrumentationPath, "utf8");
  const required = [
    "defineCatalystEveInstrumentation",
    "failure-report-root",
    "failure-report-eve-root",
  ];
  for (const marker of required) {
    if (!contents.includes(marker)) {
      throw new Error(`Native Eve instrumentation is missing ${marker}.`);
    }
  }
}

async function captureRepresentativeFailureReportFlow(tracer) {
  await withSpan(
    tracer,
    "failure_report.diagnostic_session",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "openinference.span.kind": "CHAIN",
        "input.value": JSON.stringify({
          report_id: "halo-issue-26-smoke",
          repository: "Alive24/FailureReport",
          issue_number: 26,
          operation: "inspect",
        }),
        "failure_report.report_id": "halo-issue-26-smoke",
        "failure_report.repository": "Alive24/FailureReport",
        "failure_report.issue_number": 26,
        "failure_report.native_expected.root_turn_span": "ai.eve.turn",
        "failure_report.native_expected.delegated_agent_span": "invoke_agent",
        "failure_report.native_expected.tool_span": "execute_tool",
      },
    },
    async () => {
      await withSpan(
        tracer,
        "failure_report.prepare_diagnostic_session",
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openinference.span.kind": "CHAIN",
            "failure_report.lifecycle.boundary": "diagnostic_session.prepare",
            "tool.name": "prepare_diagnostic_session",
            "input.value": JSON.stringify({
              repository: "Alive24/FailureReport",
              issue_number: 26,
              domain_extensions: ["ckb"],
            }),
            "output.value": JSON.stringify({
              status: "prepared",
              delegated_agent: "codex",
            }),
          },
        },
        async () => undefined,
      );

      await withSpan(
        tracer,
        "failure_report.codex_app_server",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "openinference.span.kind": "TOOL",
            "failure_report.lifecycle.boundary": "codex_app_server.session",
            "rpc.system": "jsonrpc",
            "rpc.service": "codex.app_server",
            "input.value": JSON.stringify({ method: "initialize" }),
            "output.value": JSON.stringify({ status: "ready" }),
          },
        },
        async () => {
          await withSpan(
            tracer,
            "failure_report.codex_model_turn",
            {
              kind: SpanKind.CLIENT,
              attributes: {
                "openinference.span.kind": "LLM",
                "llm.model_name": "codex-app-server",
                "gen_ai.system": "codex",
                "input.value": "Inspect the FailureReport trace coverage issue.",
                "output.value": "Identified native Eve coverage and semantic gaps.",
                "llm.token_count.prompt": 12,
                "llm.token_count.completion": 8,
                "llm.token_count.total": 20,
              },
            },
            async () => undefined,
          );
        },
      );

      await withSpan(
        tracer,
        "failure_report.github_handoff",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "openinference.span.kind": "TOOL",
            "failure_report.lifecycle.boundary": "github_handoff.workpad",
            "tool.name": "github_issue_workpad",
            "input.value": JSON.stringify({ marker: "<!-- shea-halo-workpad -->" }),
            "output.value": JSON.stringify({ status: "workpad-ready" }),
          },
        },
        async () => undefined,
      );
    },
  );
}

async function withSpan(tracer, name, options, callback) {
  const span = tracer.startSpan(name, options);
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await callback(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

class MultiSpanExporter {
  constructor(exporters) {
    this.exporters = exporters;
  }

  export(spans, resultCallback) {
    let remaining = this.exporters.length;
    const failures = [];
    for (const exporter of this.exporters) {
      exporter.export(spans, (result) => {
        if (result.code !== 0) {
          failures.push(result.error || new Error("span export failed"));
        }
        remaining -= 1;
        if (remaining === 0) {
          resultCallback(
            failures.length === 0
              ? { code: 0 }
              : {
                  code: 1,
                  error: new Error(failures.map((failure) => failure.message).join("; ")),
                },
          );
        }
      });
    }
  }

  async shutdown() {
    await Promise.all(this.exporters.map((exporter) => exporter.shutdown?.()));
  }

  async forceFlush() {
    await Promise.all(this.exporters.map((exporter) => exporter.forceFlush?.()));
  }
}

class StrictExporter {
  constructor(delegate, label) {
    this.delegate = delegate;
    this.label = label;
  }

  export(spans, resultCallback) {
    this.delegate.export(spans, (result) => {
      if (result.code === 0) {
        resultCallback(result);
        return;
      }
      resultCallback({
        code: 1,
        error: new Error(`${this.label} failed: ${result.error?.message || "rejected"}`),
      });
    });
  }

  shutdown() {
    return this.delegate.shutdown();
  }
}

class AtomicJsonlSpanExporter {
  constructor(outputPath) {
    this.outputPath = outputPath;
    this.records = [];
    this.exportedSpanCount = 0;
  }

  export(spans, resultCallback) {
    try {
      for (const span of spans) {
        this.records.push(toCanonicalRecord(span));
      }
      this.exportedSpanCount += spans.length;
      resultCallback({ code: 0 });
    } catch (error) {
      resultCallback({ code: 1, error });
    }
  }

  async shutdown() {
    await mkdir(dirname(this.outputPath), { recursive: true });
    const temporaryPath = `${this.outputPath}.${randomUUID()}.tmp`;
    const body = this.records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(temporaryPath, body, "utf8");
    await rename(temporaryPath, this.outputPath);
  }
}

function toCanonicalRecord(span) {
  const spanContext = span.spanContext();
  const parentSpanId =
    span.parentSpanContext?.spanId || span.parentSpanId || span.parentSpanID || "";
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    parent_span_id: parentSpanId,
    name: span.name,
    kind: SpanKind[span.kind] || String(span.kind),
    start_time: hrTimeToIso(span.startTime),
    end_time: hrTimeToIso(span.endTime),
    status: {
      code: statusCodeName(span.status?.code),
      message: span.status?.message || "",
    },
    resource: {
      attributes: span.resource?.attributes || {},
    },
    scope: {
      name: span.instrumentationScope?.name || span.instrumentationLibrary?.name || "unknown",
      version:
        span.instrumentationScope?.version || span.instrumentationLibrary?.version || "",
    },
    attributes: span.attributes || {},
    trace_state: spanContext.traceState?.serialize?.() || "",
  };
}

function hrTimeToIso(hrTime) {
  const [seconds, nanos] = hrTime;
  return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
}

function statusCodeName(code) {
  if (code === SpanStatusCode.OK) return "STATUS_CODE_OK";
  if (code === SpanStatusCode.ERROR) return "STATUS_CODE_ERROR";
  return "STATUS_CODE_UNSET";
}

async function verifyCanonicalJsonl(outputPath) {
  const raw = await readFile(outputPath, "utf8");
  const records = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (records.length < 5) {
    throw new Error(`Expected at least five trace spans; captured ${records.length}.`);
  }
  const requiredTopLevelFields = [
    "trace_id",
    "span_id",
    "name",
    "kind",
    "start_time",
    "end_time",
    "status",
    "resource",
    "scope",
    "attributes",
  ];
  for (const [index, record] of records.entries()) {
    for (const field of requiredTopLevelFields) {
      if (!(field in record)) {
        throw new Error(`Canonical span ${index} is missing ${field}.`);
      }
    }
  }
}

await main();
