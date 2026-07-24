# Architecture Overview

> **Status:** Implemented MVP. The detailed trust boundary is in [Provider Boundary](provider-boundary.md).

## Single Public Entry

Eve Root is the only public agent. Its sole product entry is the built-in Eve Channel declared at `eve/agent/channels/eve.ts`. MCP, Temporal, and the installable Codex plugin are outer wrappers that call that Channel; they never become alternate roots and do not import `eve/agent`.

Root owns intake, GitHub workpad publication, routing, aggregation, and delegation to the one declared `codex` worker. Root uses a tool-capable model, while the direct Codex App Server transport is reserved for the internal worker because it does not expose Eve's custom-tool schema. External access is governed by reachable deployment credentials and network policy, not a Root approval loop.

## Domain Capability, Session, and Worker

CKB is a mounted internal Eve extension. It contributes CKB instructions, the `failure-report-ckb-debugging` skill source, and `ckb__recommend_log`. It does not declare a sandbox, agent, session callback, worktree tool, or subagent.

`prepare_diagnostic_session` accepts report/Issue identity, a non-empty `domain_extensions` set, and a bounded request. The report target is already bound to a canonical repository identity and full immutable Git SHA. Root derives the canonical remote from the published Issue, acquires or verifies its host-managed source cache under `.eve/sandbox-cache/sources/`, then creates or restores a detached deterministic worktree under `.eve/sandbox-cache/worktrees/`. It writes `diagnostic_session` to the GitHub workpad and links every selected skill under the worktree's `.agents/skills/`. Its returned delegation begins with all selected `$failure-report-…` skill names and contains a validated session envelope. Codex decides how to use the loaded skills; extensions do not select a backend.

After Root determines the diagnosis is complete, `finalize_diagnostic_session` validates a clean detached worktree and creates and pushes a non-checked-out `diagnostic/<target-issue-number>-<issue-title-slug>` snapshot branch. The workpad records its `origin` ref and URL and marks it diagnostic-only: it is neither an implementation branch nor a PR base.

Eve is pinned to just-bash for Root orchestration. Its virtual shell is not asked to clone, fetch, run Git, or execute Codex. Root's host-side diagnostics adapters perform the controlled workspace lifecycle and inspection. The one Codex worker validates the prepared envelope, restores the persisted thread, and runs Codex App Server directly on the host with the session worktree as `cwd`, reusing the user's existing Codex Home, plugins, skills, MCP configuration, authentication, Git credentials, and model configuration. It defaults to evidence, hypotheses, experiments, and recommendations. `workspace-write` is available for focused tests, caches, and ephemeral debugging artifacts; it is not permission for business-code changes, commits, pushes, pull requests, or diagnostic finalization.

## Durable Context

A target repository has one GitHub Issue: its body remains human-readable and one marked workpad comment stores the complete structured report. `shared_context` contains collaboration binding, while `diagnostic_session` stores the selected domain extensions, backend, active/finalized lifecycle, Root-generated worktree identity/path/base/HEAD, optional Codex thread id, and optional diagnostic snapshot branch. The report accepts only `target.repository` plus a full immutable `target.revision`; it never stores or accepts a source checkout path. On every active resume Root verifies the host-managed source cache, canonical origin, containment below `.eve/sandbox-cache/`, deterministic path, detached state, base SHA, and saved HEAD. Unsafe or externally changed state requires operator input; the worker never falls back to an arbitrary checkout.

## Eve Project Layout

```text
eve/
  agent/
    agent.ts                     Root declaration
    sandbox.ts                   just-bash orchestration sandbox
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
.eve/
  sandbox-cache/
    sources/                     Root-owned canonical Git caches
    worktrees/                   Root-owned detached diagnostic worktrees
packages/
  ckb-domain-pack/               reusable Eve extension
  protocol/                      report/workpad schemas
  codex-plugin/failure-report/   installable Codex plugin
  mcp-adapter/                   outer MCP wrapper
  temporal-adapter/              outer Temporal wrapper
```

`agent/lib/` is import-only authored helper code. It is intentionally not a second Eve public surface. Its diagnostics adapters are the authorized host-runtime boundary for the fixed `.eve/sandbox-cache/` lifecycle; no caller-facing host/client API is placed inside `eve/`.

## Extension and Wrapper Rules

Create domains from Eve's extension scaffold, e.g. `npx eve@latest extension init <domain>`. Keep domain instructions, skills, and deterministic tools in `packages/<domain>-domain-pack/extension/`; register native skill assets in Root's fixed domain-extension registry. A new domain does not get a new subagent by default.

Create MCP and Temporal integrations under `packages/`. They translate their own platform requests into `RootRequest`/`RootResult` and call the default Eve Channel. They must not expose worktree paths or call domain tools directly; deployment credentials and network reachability govern which transports can connect.
