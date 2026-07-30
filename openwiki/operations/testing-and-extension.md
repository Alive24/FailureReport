---
type: Engineering Runbook
title: Operations, Testing, and Safe Change Guidance
description: FailureReport development, runtime readiness, recovery, privacy, test selection, evaluation, and extension runbook.
tags: [operations, testing, runbook, development]
---

# Operations, Testing, and Safe Change Guidance

Use this runbook with the [source map](../architecture/source-map.md). For lifecycle integrity failures, read [runtime and workspaces](../workflows/runtime-and-workspaces.md); for schema/publication failures, read [protocol and workpads](../domain/protocol-and-workpads.md).

## Development baseline

Required: Node.js 24+ and pnpm 10.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm format:check
```

The root uses Turborepo. `build` depends on package builds and may emit ignored `dist/` and `.eve/` output; `check` performs TypeScript checks; `test` depends on builds and runs Vitest suites.

For normal Eve development:

```bash
pnpm --filter @Alive24/FailureReport dev --target-workspace /absolute/path/to/target-checkout
```

`predev` runs `dev:preflight`, building only `@failure-report/protocol` and `@failure-report/ckb-domain-pack`. The launcher then requires an absolute real non-symlink target directory, canonicalizes it as the process-lifetime `FAILURE_REPORT_TARGET_WORKSPACE`, and starts `eve dev --no-ui`. Root later verifies that directory is the matching Git top level and `origin`; a request for another repository fails closed. This cold-start path must not run `pnpm add`, rewrite manifests/lockfiles, or provision Docker, a VM, or a microsandbox. Root’s `just-bash` backend has automatic installation disabled.

Clean-checkout non-interactive smoke:

```bash
pnpm --filter @Alive24/FailureReport run dev:preflight
git status --short
git diff --check
```

The Git commands should produce no tracked changes. An `EMFILE` watcher failure is a host capacity problem, not permission to mutate dependencies.

## Local runtime readiness

The MVP uses the ambient local Codex installation in two distinct roles: tool-capable Root via `experimental_chatgpt()`, and direct `codex app-server` for the diagnostic worker. Run Root from a terminal/service context where the existing Codex runtime can start and access its normal sign-in/state. FailureReport does not repair Codex Home, credentials, permissions, or global configuration.

Optional native-skill discovery smoke, which creates no model turn:

```bash
FAILURE_REPORT_RUN_CODEX_APP_SERVER_SMOKE=1 \
  pnpm --filter @Alive24/FailureReport exec vitest run test/codex-native-skill.smoke.test.ts
```

The packaged Codex plugin is installed through a configured Codex marketplace; this repository intentionally has no marketplace. For a repository-local, marketplace-free read-only inspection, build Eve production output, start an isolated process, then invoke the real MCP stdio wrapper:

```bash
cd eve
pnpm exec eve build --skip-sandbox-prewarm
pnpm run demo:start -- --target-workspace /absolute/path/to/target-checkout

# In another terminal from the repository root:
export FAILURE_REPORT_EVE_HOST="http://127.0.0.1:2000"
export FAILURE_REPORT_MCP_SESSION_STORE="/tmp/failure-report-demo-mcp.json"
pnpm --filter @failure-report/mcp-adapter demo:existing-issue -- owner/repository 123
```

`demo:start` uses a fresh temporary Eve app root so it cannot resume `eve/.eve` development state. `demo:existing-issue` sends an explicit read-only `inspect`; it does not replay diagnosis or mutate GitHub, branches, handoffs, or trackers. This is the current repository demo procedure; `/docs/demos/opensourceirl-2026-07-31-runbook.md` is the authoritative guide to its exact configuration, presentation order, live-write policy, and recovery path. See [integration boundaries](../integrations/boundaries.md) and the [completed CKBoost walkthrough](../workflows/runtime-and-workspaces.md#opensourceirl-read-only-entrypoint-and-completed-ckboost-path).

## Authentication and authority runbook

- GitHub API default: install `gh`, run `gh auth login`, and let Root obtain the active token once per process for Octokit.
- Target source access: configure ordinary host Git authentication separately. Root fetches only through the process-bound canonical checkout, verifies its `origin`, and creates diagnostic worktrees only beneath that target’s `.shea/worktrees/failureReport/`; it does not clone or select another checkout.
- Central deployments may select runtime token or GitHub App modes as documented in `/README.md`.
- Optional tracker routing and handoff delivery use `FAILURE_REPORT_HANDOFF_DELIVERY_POLICY`; the active GitHub identity needs Issue-comment write access and Project v2 read/write access, and every configured Project must define exactly one required status field plus the selected `Failure Report`, `Backlog`, or `Todo` options.
- The optional GitHub Issue Channel needs deployment-owned policy plus verified webhook/App credentials and least-privilege Issue/member access.
- The default HTTP Channel still includes placeholder auth; replace it before production third-party/browser exposure.

Never put credentials, private keys, tokens, credential output, host-local paths, raw private evidence, or adapter state into reports, Issues, prompts, logs, fixtures, plugin config, or this wiki. Refer only to environment variable names and authoritative setup docs.

## Failure and recovery rules

| Symptom | Safe response |
| --- | --- |
| Transient App Server startup/handshake/transport timeout | Preflight cleans up and retries once with a fresh process after workspace revalidation |
| Missing executable, credential/state access, skill discovery, or containment failure | Return sanitized `needs_input`; fix host/runtime externally, then retry |
| Worktree HEAD changed, branch attached, origin/path/symlink invariant failed | Stop; require operator lifecycle/integrity decision; never fall back to another checkout |
| Missing active worktree with no diagnostic commits | Root may reconstruct from immutable base after all identity checks |
| Missing worktree that had diagnostic commits | Require explicit recovery; do not silently discard evidence |
| Dirty finalization workspace | Remove ephemeral artifacts or persist evidence externally; do not finalize until clean |
| Conflicting local/remote diagnostic ref | Stop; never force-move the ref |
| Duplicate completion | Accept only byte/identity-equivalent replay; divergent duplicate becomes `needs_input` |
| Workpad fork, unknown producer, author mismatch, malformed/chunk mismatch | Stop publication and return `needs_input`; do not guess or migrate |
| Process loss during native approval | Record safe terminal interruption and do not replay the connection-bound request |
| MCP caller/process loss after Eve accepted a Root turn | Retry the identical request with the same `request_id`; the durable cursor reattaches without reposting |
| MCP delivery ownership or persisted ledger is ambiguous/corrupt | Treat the canonical key as blocked; do not delete state or resend until an operator can establish a safe recovery outside the adapter |
| Handoff marker is duplicated, foreign-authored, or content-conflicting | Stop with `needs_input`; never edit or guess which comment is authoritative |
| Handoff comment exists but workpad changed before tracker mutation | Reload the latest report binding and retry deliberately; do not move the Project from the stale delivery |
| Project, field, option, permission, or status readback is missing/ambiguous | Fix deployment-owned GitHub configuration or access; do not select another Project/state or skip readback |

A finalized diagnostic session is terminal. Continued diagnosis or implementation requires a separately designed flow; implementation must use a new worktree/branch, not the diagnostic snapshot.

## Test selection by change area

| Area | Focused suites |
| --- | --- |
| Protocol, readiness, targets, workpad envelopes/groups, handoff | `pnpm --filter @failure-report/protocol test` |
| Target binding/target `.shea`/workspace/session/finalization | Eve tests: `target-workspace`, `target-shea`, `host-managed-workspace`, `development-entrypoint`, `codex-diagnostic-session` |
| Codex preflight/transport/approvals | Eve tests: `codex-app-server-preflight`, `codex-app-server-transport`, `codex-app-server-direct-transport`, `native-approval-broker` |
| Completion, handoff rendering, and delivery races | Eve tests: `diagnostic-completion-reconciliation`, `handoff-renderer`, `handoff-delivery` |
| GitHub workpad/gateway and Project routing | Eve tests: `issue-workpad`, `octokit-issue-gateway`, `github-cli-issue-gateway`, `project-tracker` |
| GitHub ingress policy | Eve test: `github-issue-channel` plus documented UAT |
| Extension and native skills | CKB package tests, `codex-diagnostic-session`, optional native-skill smoke |
| MCP | Adapter contract and Channel configuration; `root-operation-lifecycle`, `eve-channel-root-invoker`, `eve-channel-root-transport`, and existing-Issue smoke tests |
| Temporal | Temporal Activity tests and deterministic workflow build/check |
| Cold start and Root defaults | Eve tests: `development-entrypoint`, `root-runtime-default` |
| Shea outer workflow contracts | Eve test: `shea-workflow-contract` when touching Shea prompts/workflows |

For a focused Eve file:

```bash
pnpm --filter @Alive24/FailureReport exec vitest run test/<name>.test.ts
```

Finish cross-package changes with root `pnpm build`, `pnpm check`, `pnpm test`, and `pnpm format:check`.

## GitHub Channel UAT

Before enabling the optional ingress in production, use a configured test repository and verify:

- an active configured-team member can mention the bot and answer one known missing-information prompt;
- non-members, pending members, unconfigured repositories, invalid webhooks, revoked access, and missing member-read permission do not dispatch or reveal policy;
- PR/review/CI/Issue-open/ordinary comments do not start a turn;
- no Eve checkout is created; only Root creates diagnostic source/worktree state.

The source-of-truth checklist and exact permission guidance are in `/README.md`.

## Evaluations

Application-level fixtures live under `/eve/evals/ckb/` because they exercise Root-to-worker behavior, evidence traceability, diagnosis, and handoff quality. Run from the Eve app only when model credentials and protected artifact bindings are available:

```bash
pnpm --filter @Alive24/FailureReport eval
```

`ckb/issue-45-sparse` is designed for public fixture material. Issue 54 is blind evaluation material: bind protected references at the host and do not expose gold evidence to Root or copy protected data into docs.

## Safe change guidance

- **Protocol change:** update schemas first, preserve strict rejection where intended, then update all adapters and persistence tests. Do not silently migrate removed fields.
- **Workspace change:** preserve one process-bound canonical target checkout, target-owned `.shea/worktrees/failureReport/`, copy-missing-only defaults, path privacy, canonical origin, containment, detached/base/HEAD checks, and fail-closed behavior. Never reintroduce request-selected paths or fallback cloning.
- **Workpad change:** preserve append-only bytes, immutable producer/author provenance, linear lineage, provider-private budgets, and manifest visibility semantics.
- **Backend change:** preserve preflight/turn separation, ambient-host inheritance, bounded cleanup/retry, process-bound approvals, and sanitized durable evidence.
- **Extension change:** follow the [capability-only extension model](../domain/extensions.md); do not couple a domain pack to a provider or workspace.
- **Integration change:** follow [outer adapter boundaries](../integrations/boundaries.md); use the default Channel and shared protocol.
- **Handoff change:** keep `render_handoff` read-only, revision-bound, and deterministic. Keep `deliver_handoff` as the separate configured side-effect boundary; preserve the fixed structured handoff, template containment/validation, marker idempotency, second render, tracker readback, and receipt-to-handoff identity binding. Never infer downstream implementation from delivery to `Todo`.

## OpenWiki maintenance policy

Maintainers refresh `/openwiki` by explicitly running OpenWiki after authoritative source or documentation changes. There is no scheduled GitHub Actions workflow for OpenWiki updates. Generated pages should not be hand-edited outside an explicit documentation maintenance run; change the authoritative source first, then run a surgical wiki update such as this one. The [source map](../architecture/source-map.md) identifies the primary evidence to inspect before editing a concept.

## Operational exclusions

Do not use `/.eve` runtime state, `/.shea/logs`, `/.shea/artifacts`, `/.shea/worktrees`, generated build output, caches, or temporary diagnostic evidence as documentation sources or committed artifacts. Avoid reading `.env` files. Inspect recent git history when a boundary seems surprising; current high-signal changes concern cold start, authorized GitHub ingress, direct App Server approvals, deterministic handoff, private worktree paths, and provider-bounded append-only workpads.
