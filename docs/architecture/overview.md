# Architecture Overview

> **Status:** Implemented MVP. The detailed trust boundary is in [Provider Boundary](provider-boundary.md).

## Single Public Entry

Eve Root is the only public agent. Its sole product entry is the built-in Eve Channel declared at `eve/agent/channels/eve.ts`. MCP, Temporal, and the installable Codex plugin are outer wrappers that call that Channel; they never become alternate roots and do not import `eve/agent`.

Root owns intake, approval, GitHub workpad publication, routing, aggregation, and delegation to the one declared `codex` worker. Root uses a tool-capable model, while the Codex App Server provider is reserved for the internal worker because it does not expose Eve's custom-tool schema.

## Domain Capability, Session, and Worker

CKB is a mounted internal Eve extension. It contributes CKB instructions, the `failure-report-ckb-debugging` skill source, and `ckb__recommend_log`. It does not declare a sandbox, agent, session callback, worktree tool, or subagent.

Root's always-approved `prepare_diagnostic_session` tool accepts report/Issue identity, a non-empty `domain_extensions` set, and a bounded request. Root's fixed extension registry resolves every installed skill source, creates or restores a detached deterministic worktree, writes `diagnostic_session` to the GitHub workpad, and links every selected skill under the worktree's `.agents/skills/`. Its returned delegation begins with all selected `$failure-report-…` skill names and contains a validated session envelope. Codex decides how to use the loaded skills; extensions do not select a backend.

After Root determines the diagnosis is complete, its separate always-approved `finalize_diagnostic_session` tool validates a clean detached worktree and creates a non-checked-out `failure-report/diagnostic/<identity>` snapshot branch. The workpad marks it diagnostic-only: it is neither an implementation branch nor a PR base.

The one Codex worker validates that envelope, restores the persisted thread, and runs Codex App Server with the session worktree as `cwd`. It defaults to evidence, hypotheses, experiments, and recommendations. `workspace-write` is available for tests/cache/debug artifacts; it is not permission to edit business code or commit without explicit Root authorization.

## Durable Context

A target repository has one GitHub Issue: its body remains human-readable and one marked workpad comment stores the complete structured report. `shared_context` contains collaboration binding, while `diagnostic_session` stores the selected domain extensions, backend, active/finalized lifecycle, worktree identity/path/base/HEAD, optional Codex thread id, and optional diagnostic snapshot branch. On every active resume Root validates source checkout, origin, deterministic path, detached state, base, and saved HEAD. Unsafe or externally changed state requires operator input; the worker never falls back to the source checkout.

## Eve Project Layout

```text
eve/
  agent/
    agent.ts                     Root declaration
    channels/eve.ts              only public Eve entry
    instructions.md              Root policy
    tools/
      prepare_diagnostic_session.ts
      finalize_diagnostic_session.ts
    extensions/
      ckb.ts                     pure CKB capability mount
    subagents/
      codex/                     one generic diagnostic worker
    lib/
      diagnostics/               Root session, extension registry, worktree, envelope
      backends/                  Codex App Server adapter
      integrations/github/       Root-owned workpad gateway
  config/                        Root and worker configuration
  evals/                         immutable eval fixtures
packages/
  ckb-domain-pack/               reusable Eve extension
  protocol/                      report/workpad schemas
  codex-plugin/failure-report/   installable Codex plugin
  mcp-adapter/                   outer MCP wrapper
  temporal-adapter/              outer Temporal wrapper
```

`agent/lib/` is import-only authored helper code. It is intentionally not a second Eve host surface, and no host/client implementation is placed inside `eve/`.

## Extension and Wrapper Rules

Create domains from Eve's extension scaffold, e.g. `npx eve@latest extension init <domain>`. Keep domain instructions, skills, and deterministic tools in `packages/<domain>-domain-pack/extension/`; register native skill assets in Root's fixed domain-extension registry. A new domain does not get a new subagent by default.

Create MCP and Temporal integrations under `packages/`. They translate their own platform requests into `RootRequest`/`RootResult` and call the default Eve Channel. They must not expose worktree paths, call domain tools, or bypass Root approval.
