# Architecture Overview

> **Status:** Implemented MVP. The detailed trust boundary is in [Provider Boundary](provider-boundary.md).

## Single Public Entry

Eve Root is the only public agent. Its sole product entry is the built-in Eve Channel declared at `eve/agent/channels/eve.ts`. MCP, Temporal, and the installable Codex plugin are outer wrappers that call that Channel; they never become alternate roots and do not import `eve/agent`. Before the plugin's MCP wrapper delivers a Root turn, its private runtime supervisor either verifies a pinned remote Eve health/repository binding or resolves an operator-owned managed-local checkout, verifies its origin, single-flights the supported production start path, and waits for the same authenticated binding proof. Supervisor paths, locks, state, logs, and process identity never enter the public protocol; Root remains the sole owner of diagnosis and diagnostic workspaces.

Root owns intake, GitHub workpad publication, routing, aggregation, and delegation to the one declared `codex` worker. Root uses a tool-capable model, while the direct Codex App Server transport is reserved for the internal worker because it does not expose Eve's custom-tool schema. External access is governed by reachable deployment credentials and network policy, not a Root approval loop.

The supported local launcher builds production output and runs `eve start` without a watcher from a stable ignored production app root. Before Eve accepts work it composes the same Root-owned target-workspace and target-`.shea` components to prove canonical Git top-level/origin, fetch authority, missing-only asset/write authority, and any configured delivery template. Startup cannot know an Issue's repository/SHA binding, so `acquire` still verifies both exact values before delegation or delivery. Watcher development and isolated demo modes use the same host readiness boundary but retain their distinct state and watcher semantics.

## Domain Capability, Session, and Worker

CKB is a mounted internal Eve extension. It contributes CKB instructions, the `failure-report-ckb-debugging` skill source, and `ckb__recommend_log`. It does not declare a sandbox, agent, session callback, worktree tool, or subagent.

`prepare_diagnostic_session` accepts report/Issue identity, a `domain_extensions` set, and a bounded request. The set may be empty for a generic diagnosis; domain extensions are optional additive capabilities, not a worker prerequisite. The report target is already bound to a canonical repository identity and full immutable Git SHA. One FailureReport process is bound at startup to one canonical target checkout. Root derives the canonical remote from the published Issue, verifies that the process-bound checkout is the matching real Git top level, fetches the requested revision, then bootstraps missing target-owned FailureReport prompts and templates from authored `eve/config/failure-report/` defaults. Existing target files are never overwritten. Root creates or restores the detached deterministic worktree only beneath the target checkout's `.shea/worktrees/failureReport/`. It writes `diagnostic_session` to the GitHub workpad and links every selected skill under the worktree's `.agents/skills/`. A domain-specific delegation begins with the selected `$failure-report-…` skill names; a generic delegation explicitly uses repository instructions and standard diagnostic capabilities. Both receive the target-owned intake and synthesis guidance plus the same validated session envelope. Codex decides how to use selected skills; extensions do not select a backend.

After Root determines the diagnosis is complete, `finalize_diagnostic_session` validates a clean detached worktree and creates and pushes a non-checked-out `diagnostic/<target-issue-number>-<issue-title-slug>` snapshot branch. The workpad records its `origin` ref and URL and marks it diagnostic-only: it is neither an implementation branch nor a PR base.

`render_handoff` is the consumer-neutral boundary after diagnosis. It reads the latest managed workpad twice around a pure render, rejects stale caller revisions or concurrent lineage changes, and performs no write. A report is renderable as an implementation handoff only when its target revision, completion lineage, finalized worktree HEAD, and diagnostic-only remote snapshot agree and the gate is exactly `Ready`. The versioned handoff identifies the report, Issue, workpad entry/revision, immutable target, completion records, snapshot, and evidence refs, then carries only implementation goal, scope, guardrails, required outcomes, verification, UAT, and residual risks. Canonical key and set ordering plus SHA-256 identity derivation make equivalent durable input byte-identical.

An optional deployment-owned delivery policy adds two Root-only mutation boundaries without changing that renderer. A repository entry may remain tracker-free: `begin_failure_report` is then a no-op and `deliver_handoff` publishes only to the target Issue. If the target explicitly binds its own GitHub Project v2, intake moves to its `Failure Report` status and delivery moves only to configured `Backlog` or `Todo` after readback. The status option must exist in that Project but is intentionally absent from Shea Symphony's workflow mapping. `deliver_handoff` reuses the pure renderer, loads the target-owned `.shea/template/failureReport/implementation.md` by default, and creates or reuses one deterministic marker-bound human-readable comment. A folded canonical handoff plus delivery intent is always appended independently of the presentation template. `Backlog` stops for manual promotion, while `Todo` is the downstream Shea entry. FailureReport does not own any later implementation, review, merge, or terminal state.

Material uncertainty takes the other mutually exclusive result path. Root returns a versioned human-input request containing confirmed facts, completed or exhausted experiments, eliminated hypotheses, one remaining material unknown, viable options, exactly one question, and a resume condition. That path requires the same diagnostic session to remain `active`, with its worktree and Codex thread persisted and no diagnostic branch. The durable workpad remains the full evidence source in both cases.

Eve is pinned to just-bash for Root orchestration. Its virtual shell is not asked to clone, fetch, run Git, or execute Codex. Root's host-side diagnostics adapters perform the controlled workspace lifecycle and inspection. The one Codex worker validates the prepared envelope, restores the persisted thread, and runs Codex App Server directly on the host with the session worktree as `cwd`, reusing the user's existing Codex Home, plugins, skills, MCP configuration, authentication, Git credentials, and model configuration. It defaults to evidence, hypotheses, experiments, and recommendations. `workspace-write` is available for focused tests, caches, and ephemeral debugging artifacts; it is not permission for business-code changes, commits, pushes, pull requests, or diagnostic finalization.

## Durable Context

A target repository has one GitHub Issue: its body remains human-readable and one marked workpad comment stores the complete structured report. `shared_context` contains collaboration binding, while `diagnostic_session` stores the selected domain extensions, backend, active/finalized lifecycle, Root-generated worktree identity/base/HEAD, optional Codex thread id, and optional diagnostic snapshot branch. The host-local checkout and worktree paths are never part of the public report. The report accepts only `target.repository` plus a full immutable `target.revision`; it never stores or accepts a source checkout path. For the first Issue-only request, the launcher resolves the already verified, process-bound checkout's current commit and `read_shared_context` supplies that private repository/SHA binding to Root; the reporter never supplies a SHA. On every active resume Root revalidates the same process-bound checkout, its origin, the target `.shea` directories and assets, the deterministic worktree path, containment, detached state, base SHA, and saved HEAD. Unsafe or externally changed state requires operator input; the worker never falls back to an arbitrary checkout or another repository.

Each immutable workpad entry also carries a standalone Markdown projection of that same schema-validated report. The projection is selected from canonical state only: Active, Need Human Input, or Completed. It preserves collection order, bounds ordinary collections at 10 visible items, leaves material human-input fields complete, and escapes report-authored Markdown and mentions. It has no model-authored summary and no dependency on a prior revision. Normal entries fold the complete canonical JSON beneath this view. Oversized revisions put the equivalent human semantics in the authoritative final manifest, followed by its folded ordered chunk references, digests, and reconstruction procedure; provisional chunks remain folded and machine-oriented.

The MCP wrapper separately owns private transport durability. Its on-disk ledger records prepared, delivered, queued, terminal, and cleaned operations per canonical Issue/report session key. Eve exposes the allocated session cursor as soon as a message delivery is accepted, so the wrapper persists that cursor before consuming the long-running terminal stream. Process or caller loss can then reattach to the delivered turn without posting its Root message again. Only one turn is delivered per canonical key at a time; unrelated keys use independent pumps. This ledger is never part of `RootRequest`, `RootResult`, the GitHub workpad, or the diagnostic handoff.

## Eve Project Layout

```text
eve/
  agent/
    agent.ts                     Root declaration
    sandbox.ts                   just-bash orchestration sandbox
    channels/eve.ts              only public Eve entry
    instructions.md              Root policy
    tools/
      begin_failure_report.ts
      prepare_diagnostic_session.ts
      finalize_diagnostic_session.ts
      render_handoff.ts
      deliver_handoff.ts
    extensions/
      ckb.ts                     pure CKB capability mount
    subagents/
      codex/                     one generic diagnostic worker
    lib/
      diagnostics/               Root session, extension registry, worktree, envelope
      backends/                  Codex App Server adapter
      delivery/                  configured intake and handoff delivery
      integrations/github/       Root-owned workpad and Project gateways
  config/                        Root and worker backend configuration
  evals/                         immutable eval fixtures
eve/config/failure-report/
  prompts/                       Authored target-default diagnostic prompts
  templates/                     Authored target-default handoff templates
.shea/                           Shea Symphony development config for FailureReport
<target-canonical-checkout>/.shea/
  prompts/failureReport/         Target-owned prompt copies or customizations
  template/failureReport/        Target-owned handoff template
  worktrees/failureReport/       Root-managed detached diagnostic worktrees
packages/
  ckb-domain-pack/               reusable Eve extension
  protocol/                      report/workpad schemas
  codex-plugin/failure-report/   installable Codex plugin
  mcp-adapter/                   outer MCP wrapper
  temporal-adapter/              outer Temporal wrapper
```

`agent/lib/` is import-only authored helper code. It is intentionally not a second Eve public surface. Its diagnostics adapters are the authorized host-runtime boundary for process-bound target verification, target `.shea` bootstrapping, and worktree lifecycle; no caller-facing host/client API is placed inside `eve/`. The repository-root `.shea/` remains exclusively part of the Shea Symphony workflow used to develop FailureReport itself.

## Extension and Wrapper Rules

Create domains from Eve's extension scaffold, e.g. `npx eve@latest extension init <domain>`. Keep domain instructions, skills, and deterministic tools in `packages/<domain>-domain-pack/extension/`; register native skill assets in Root's fixed domain-extension registry. A new domain does not get a new subagent by default.

Create MCP and Temporal integrations under `packages/`. They translate their own platform requests into `RootRequest`/`RootResult` and call the default Eve Channel. They must not expose worktree paths or call domain tools directly; deployment credentials and network reachability govern which transports can connect.
