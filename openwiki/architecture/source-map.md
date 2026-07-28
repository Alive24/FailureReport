---
type: Source Map
title: FailureReport Source Map
description: Practical navigation map to authoritative contracts, runtime entrypoints, packages, tests, examples, and generated or excluded areas.
tags: [source-map, repository, navigation]
---

# Source Map

Use this page to choose the smallest authoritative source set before changing code. Read the [architecture overview](overview.md) first when ownership is unclear, then follow the relevant row.

## Root and repository

| Path | Role | Start here when |
| --- | --- | --- |
| `/README.md` | Product/runtime contract, local runbook, GitHub setup, extension rules | You need current supported behavior or operator guidance |
| `/docs/architecture/overview.md` | Implemented MVP topology | You are changing responsibility or component composition |
| `/docs/architecture/provider-boundary.md` | Detailed trust, provider, workspace, approval, and handoff boundaries | A change crosses Root, extension, Codex, or host-state boundaries |
| `/package.json`, `/turbo.json`, `/pnpm-workspace.yaml` | Workspace scripts and task graph | You are changing build/check/test orchestration |
| `/openwiki/INSTRUCTIONS.md` | User-authored wiki scope | You are maintaining this wiki; do not rewrite it routinely |

## Eve application

| Path | Role |
| --- | --- |
| `/eve/agent/agent.ts` | Sole Root declaration and startup-parsed model configuration |
| `/eve/config/root/backend/root.json` | Current local-first Root backend selection |
| `/eve/agent/instructions.md` | Normative Root lifecycle and publication policy |
| `/eve/agent/channels/eve.ts` | Default `/eve/v1/session*` HTTP ingress |
| `/eve/agent/channels/github.ts` | Optional team-authorized Issue-comment ingress |
| `/eve/agent/tools/` | Root tools for workpad read/publish, prepare/finalize, handoff rendering, configured intake routing, and handoff delivery |
| `/eve/agent/lib/diagnostics/` | Source cache, detached worktree, session, completion, extension registry, envelope, finalization, and handoff helpers |
| `/eve/agent/lib/delivery/` | Deployment-owned delivery policy, safe template loading/rendering, intake routing, and receipt creation |
| `/eve/agent/lib/backends/` | Root model plus direct Codex App Server preflight, transport, model wrapper, and approval broker |
| `/eve/agent/lib/integrations/github/` | Workpad codec/provenance, optimistic publication, authorization, and Octokit/legacy CLI gateways |
| `/eve/agent/subagents/codex/` | The single consumer-owned diagnostic worker and its restrictions |
| `/eve/agent/extensions/ckb.ts` | Mount point for the reusable CKB domain extension |
| `/eve/config/workers/codex-app-server.json` | Worker command and execution policy |

The diagnostic helpers under `agent/lib/` are host-runtime implementation owned by Root. They are not public adapter APIs and are never mounted into the target diagnostic worktree. Their interaction is documented in [runtime and workspaces](../workflows/runtime-and-workspaces.md).

## Workspace packages

| Package | Canonical role | Key sources |
| --- | --- | --- |
| `@failure-report/protocol` | Strict Zod request/result, report, session, workpad, and handoff contract | `/packages/protocol/src/index.ts`, `/packages/protocol/src/handoff.ts` |
| `@failure-report/ckb-domain-pack` | Reusable pure CKB Eve extension | `/packages/ckb-domain-pack/README.md`, `/packages/ckb-domain-pack/AGENTS.md`, `/packages/ckb-domain-pack/extension/` |
| `@failure-report/mcp-adapter` | One-tool stdio wrapper plus private durable single-flight operation ledger over the Eve Channel | `/packages/mcp-adapter/src/index.ts`, `eve-channel-root-invoker.ts`, `root-operation-store.ts`, and focused adapter tests |
| `@failure-report/temporal-adapter` | Deterministic workflow plus externally supplied Root Activity | `/packages/temporal-adapter/src/workflow.ts`, `/packages/temporal-adapter/src/activities.ts` |
| Codex plugin | Installable skill and MCP composition | `/packages/codex-plugin/failure-report/README.md`, `.mcp.json`, `skills/failure-report/SKILL.md` |

## Examples and extension points

- `/examples/add-custom-subagent/README.md` distinguishes a consumer-owned runtime worker from a domain extension.
- `/examples/temporal-host/README.md` shows Activity ownership and why workflow code must remain deterministic.
- `/examples/mcp-host/` contains outer MCP host composition; it must still call Root through the default Channel.
- The [domain extension guide](../domain/extensions.md) covers the supported package/mount/registry sequence.
- The [integration guide](../integrations/boundaries.md) covers outer adapter rules.

## Verification sources

- `/packages/protocol/test/protocol.test.ts` — schema strictness, generic empty-extension sessions, legacy rejection, readiness, workpad envelopes/groups, and handoff determinism.
- `/eve/test/codex-diagnostic-session.test.ts` and `/eve/test/codex-app-server-preflight.test.ts` — generic or extension-assisted allocation, restore, skill discovery, thread state, finalization, and snapshot policy.
- `/eve/test/source-cache.test.ts` and `/eve/test/host-managed-workspace.test.ts` — fixed ownership, origin, containment, path privacy, and Git invariants.
- `/eve/test/codex-app-server-*.test.ts` and `/eve/test/native-approval-broker.test.ts` — preflight, transport, process lifecycle, events, approvals, and failure classification.
- `/eve/test/diagnostic-completion-reconciliation.test.ts` and `/eve/test/handoff-renderer.test.ts` — append-safe completions and read-only revision-bound output.
- `/eve/test/issue-workpad.test.ts`, `/eve/test/octokit-issue-gateway.test.ts`, `/eve/test/github-issue-channel.test.ts` — provenance, publication groups, races, and authorized ingress.
- `/packages/mcp-adapter/test/root-operation-lifecycle.test.ts`, `eve-channel-root-invoker.test.ts`, and `eve-channel-root-transport.test.ts` — canonical-key ownership, queueing, single-flight, cursor timing, restart reattachment, fail-closed ambiguity, retention, and v1 migration.
- `/eve/evals/README.md` and `/eve/evals/ckb/` — application-level quality evaluation, including protected-evidence handling.

See [operations and testing](../operations/testing-and-extension.md) for commands and change-focused test selection.

## Excluded or non-authoritative areas

Do not document or inspect secrets, `.env` files, `/.eve` runtime state, `/.shea/logs`, `/.shea/artifacts`, `/.shea/worktrees`, generated `dist/`, caches, temporary diagnostic evidence, or target worktrees. Fixtures are evidence of expected behavior only when aligned with current schemas and tests; they are not authority for unsupported runtime conclusions. Root-level `/AGENTS.md` and `/CLAUDE.md` currently point readers to this generated wiki but are not generated documentation. not generated documentation.
