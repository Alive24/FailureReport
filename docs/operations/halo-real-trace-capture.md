# Real Root-to-Codex trace capture

FailureReport exposes one opt-in command for a Shea Halo candidate experiment:

```bash
pnpm halo:trace-capture-real
```

This is a real, model-backed demo/test harness. It starts the candidate FailureReport checkout, rehydrates one operator-approved fresh fixture Issue, verifies that the initial observation is revision zero with no managed FailureReport lineage, runs one Eve Root diagnosis through the declared Codex worker, captures the framework-native Catalyst/OpenTelemetry stream on an ephemeral loopback listener, and atomically finalizes HALO canonical one-span-per-line JSONL. It is not the synthetic exporter-contract smoke from FailureReport #26, the read-only native verifier tracked by FailureReport #30, or a product trace backend.

## Required runtime configuration

The operator must provide all six values:

| Environment variable | Contract |
| --- | --- |
| `FAILURE_REPORT_TRACE_FIXTURE_REPOSITORY` | GitHub `owner/repository` for the disposable fixture |
| `FAILURE_REPORT_TRACE_FIXTURE_ISSUE_NUMBER` | Positive existing Issue number selected for this run |
| `FAILURE_REPORT_TRACE_FIXTURE_REVISION` | Full immutable revision currently checked out by the fixture |
| `FAILURE_REPORT_TRACE_TARGET_CHECKOUT` | Absolute real path to that clean fixture checkout |
| `FAILURE_REPORT_TRACE_EXPECTED_SOURCE_REVISION` | Full immutable `HEAD` of the clean FailureReport candidate checkout |
| `FAILURE_REPORT_TRACE_OUTPUT_DIRECTORY` | Absolute empty directory strictly below the candidate’s ignored `.shea/artifacts/halo/` tree |

The target checkout’s canonical `origin`, `HEAD`, and clean state must match the fixture identity. The candidate checkout’s `HEAD` and clean state must match the expected source revision. A mutable ref such as a branch or tag is never accepted.

Do not set `CATALYST_OTLP_TOKEN` or `OTLP_INGEST_TOKEN`. The harness creates its own ephemeral `127.0.0.1` collector and overrides export configuration for the child runtime. Any preconfigured tracing endpoint must already be a credential-free `http://127.0.0.1` URL; DNS names, redirects, HTTPS, LAN/public addresses, URL credentials, query strings, and fragments fail before startup.

The command intentionally suppresses child logs and never prints the Root request, model content, tool payloads, endpoints, credentials, or host paths. Raw canonical traces remain only in the configured ignored directory with owner-only permissions.

## Outputs and exit contract

On success the empty output directory receives:

- `traces.jsonl` — atomically renamed canonical JSONL with native identities, parentage, nanosecond timestamps, status, resource/scope identity, attributes, events, and links;
- `receipt.json` — the same bounded receipt written to standard output.

The v2 receipt contains only bounded, sanitized evidence:

- the full fixture repository, Issue number, and immutable fixture revision;
- the full candidate source revision and exact canonical JSONL SHA-256 digest;
- total spans and traces, the unique composite trace/span identity count, verified in-dataset parent edges, explicit external or unexported parent edges, and maximum verified internal depth;
- native Eve Root/tool/delegated-Codex operation counts;
- the accepted initial rehydration status, `initial_workpad_revision: 0`, `initial_managed_lineage: false`, and `diagnosis_status: completed`.

It contains no artifact path, endpoint, credential, prompt, payload, raw attribute, private artifact reference, or transport detail. The canonical JSONL retains an observed `parent_span_id` even when its parent was outside the exported dataset; the receipt counts that edge as external and never treats it as verified internal hierarchy.

The command exits nonzero and does not publish `traces.jsonl` when readiness, Root/Codex execution, OTLP acceptance, exporter quiescence, shutdown, canonical conversion, or any evidence invariant fails. Validation requires:

- a non-empty unique native span set;
- unique composite trace/span identities;
- a verified in-dataset hierarchy at least three levels deep, with external or unexported parent edges preserved and counted separately;
- the exact expected `service.version` on every span;
- native `ai.eve.turn`, Eve tool, and delegated `codex` operations.

The run fails before diagnosis when the selected Issue is missing, mismatched, already has managed FailureReport lineage, or is not observed at `workpad_revision: 0`. It fails before finalization when diagnosis is not `completed`, any trace/span identity repeats, any span reports a different `service.version`, or an external parent edge is the only reason a hierarchy would appear deep enough. These checks are evidence requirements; do not relax them to reuse a consumed fixture.

The fixture Issue may receive only the append-only workpad activity produced by the normal real FailureReport flow. Use a dedicated disposable Issue and review that activity after the run.

## Shea Halo configured action

Configure the candidate experiment as a runtime action executed from the fixed candidate worktree. Bind the six variables above from operator-owned Halo runtime configuration, set the expected source revision to the candidate SHA, select a disposable Issue with no FailureReport workpad lineage, and choose a fresh empty leaf below `.shea/artifacts/halo/`. The action itself is exactly:

```text
pnpm halo:trace-capture-real
```

Do not add a `cp` action, historical JSONL input, alternate collector, or post-capture relabeling step. After the command succeeds, verify that the public receipt names the intended fixture and both immutable revisions, reports the fresh initial lifecycle and completed diagnosis, and contains only the bounded fields above. Give HALO Engine the exact `traces.jsonl` digest and the same candidate revision from the receipt; exact-dataset validation must confirm uniform service version, unique identities, and the internal/external parent-edge classification. Shea Halo remains responsible for its complete research-run bundle and final candidate validation.
