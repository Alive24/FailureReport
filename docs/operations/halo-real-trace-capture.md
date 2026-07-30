# Real Root-to-Codex trace capture

FailureReport exposes one opt-in command for a Shea Halo candidate experiment:

```bash
pnpm halo:trace-capture-real
```

This is a real, model-backed demo/test harness. It starts the candidate FailureReport checkout, asks Eve Root to read and diagnose one operator-approved existing fixture Issue in a single turn through the declared Codex worker, captures the framework-native Catalyst/OpenTelemetry stream on an ephemeral loopback listener, and atomically finalizes HALO canonical one-span-per-line JSONL. It is not the synthetic exporter-contract smoke from FailureReport #26, the read-only native verifier tracked by FailureReport #30, or a product trace backend.

## Required runtime configuration

The operator must provide the five fixture and output values below. The source revision comes from Shea Halo's standard candidate binding during a managed experiment, or from an explicit standalone-UAT override:

| Environment variable | Contract |
| --- | --- |
| `FAILURE_REPORT_TRACE_FIXTURE_REPOSITORY` | GitHub `owner/repository` for the disposable fixture |
| `FAILURE_REPORT_TRACE_FIXTURE_ISSUE_NUMBER` | Positive existing Issue number selected for this run |
| `FAILURE_REPORT_TRACE_FIXTURE_REVISION` | Full immutable revision currently checked out by the fixture |
| `FAILURE_REPORT_TRACE_TARGET_CHECKOUT` | Absolute real path to that clean fixture checkout |
| `FAILURE_REPORT_TRACE_OUTPUT_DIRECTORY` | Absolute empty directory strictly below the candidate’s ignored `.shea/artifacts/halo/` tree |

Shea Halo sets `CATALYST_SERVICE_VERSION` to the exact fixed candidate revision for post-publication experiments, and this command uses that value as the expected FailureReport source revision. A standalone operator UAT may instead set `FAILURE_REPORT_TRACE_EXPECTED_SOURCE_REVISION` to the full immutable `HEAD`. If both values are present, they must be identical or the command fails before startup.

The target checkout’s canonical `origin`, `HEAD`, and clean state must match the fixture identity. The candidate checkout’s `HEAD` and clean state must match the expected source revision. A mutable ref such as a branch or tag is never accepted.

Do not set `CATALYST_OTLP_TOKEN` or `OTLP_INGEST_TOKEN`. The harness creates its own ephemeral `127.0.0.1` collector and overrides export configuration for the child runtime. Any preconfigured tracing endpoint must already be a credential-free `http://127.0.0.1` URL; DNS names, redirects, HTTPS, LAN/public addresses, URL credentials, query strings, and fragments fail before startup.

The command intentionally suppresses child logs and never prints the Root request, model content, tool payloads, endpoints, credentials, or host paths. Raw canonical traces remain only in the configured ignored directory with owner-only permissions.

## Outputs and exit contract

On success the empty output directory receives:

- `traces.jsonl` — atomically renamed canonical JSONL with native identities, parentage, nanosecond timestamps, status, resource/scope identity, attributes, events, and links;
- `receipt.json` — the same bounded receipt written to standard output.

The receipt contains only the schema version, exact candidate revision, JSONL digest, span/trace/topology counts, native Eve Root/tool/delegated-Codex operation counts, `complete` classification, and safe fixture identity. It contains no artifact path or transport details.

The command exits nonzero and does not publish `traces.jsonl` when readiness, Root/Codex execution, OTLP acceptance, exporter quiescence, shutdown, canonical conversion, or any evidence invariant fails. Validation requires:

- a non-empty unique native span set;
- complete in-dataset parent references and a hierarchy at least three levels deep;
- the exact expected `service.version` on every span;
- native `ai.eve.turn`, Eve tool, and delegated `codex` operations.

The fixture Issue may receive only the append-only workpad activity produced by the normal real FailureReport flow. Use a dedicated disposable Issue and review that activity after the run.

## Shea Halo configured action

Configure the candidate experiment as a runtime action executed from the fixed candidate worktree. Bind the five operator-owned variables above from Halo runtime configuration and choose a fresh empty leaf below `.shea/artifacts/halo/`. Halo supplies the exact candidate SHA through `CATALYST_SERVICE_VERSION`. The action itself is exactly:

```text
pnpm halo:trace-capture-real
```

Do not add a `cp` action, historical JSONL input, alternate collector, or post-capture relabeling step. After the command succeeds, give HALO Engine the exact `traces.jsonl` digest and the same candidate revision from the receipt. Shea Halo remains responsible for its complete research-run bundle and final candidate validation.
