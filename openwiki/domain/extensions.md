---
type: Extension Model Guide
title: Domain Extensions and Worker Extension Points
description: FailureReport’s capability-only domain extension model, current CKB implementation, native skill materialization, and safe addition of domains or runtime workers.
tags: [extensions, ckb, skills, codex]
---

# Domain Extensions and Worker Extension Points

A domain extension packages reusable diagnostic capability. It is deliberately different from a consumer-owned worker: the extension knows the domain, while [Eve Root owns workflow and workspaces](../architecture/overview.md) and Codex supplies generic diagnostic execution.

## Allowed extension shape

A package under `packages/<domain>-domain-pack/extension/` may contribute:

- instruction fragments and domain knowledge;
- Eve skills and package-owned native Codex skills;
- deterministic, namespaced tools;
- connections and hooks allowed by Eve’s extension model;
- internal extension helpers.

It may not declare an agent, sandbox, schedule, nested extension, provider configuration, worktree/session policy, consumer callback, or subagent. The mount under `/eve/agent/extensions/<domain>.ts` supplies the namespace. Keep tool names local (`recommend_log`, not a manually prefixed duplicate); Eve composition exposes names such as `ckb__recommend_log`.

This capability boundary connects the extension to the [Root-managed diagnostic lifecycle](../workflows/runtime-and-workspaces.md) without giving it control of the backend or host state.

## Current CKB extension

`@failure-report/ckb-domain-pack` is the only installed production domain extension currently registered. It contributes:

- CKB investigation instructions;
- deterministic `ckb__recommend_log` guidance;
- the Eve-mounted `failure-report-ckb-debugging` skill source;
- the native Codex skill `$failure-report-ckb-debugging` for transaction assembly, contract validation, RPC/indexer, Nostr relay, and deployment boundaries.

Canonical sources are `/packages/ckb-domain-pack/README.md`, `/packages/ckb-domain-pack/AGENTS.md`, `/packages/ckb-domain-pack/extension/`, and `/eve/agent/extensions/ckb.ts`.

CKB does not own a worktree or subagent. When Root selects `ckb`, it resolves the installed package’s skill asset through the fixed registry in `/eve/agent/lib/diagnostics/domain-extensions.ts` and materializes a safe worktree-local `.agents/skills/failure-report-ckb-debugging` symlink. The Codex worker uses native skill discovery and the explicit `$skill` at the beginning of Root’s delegation; Eve’s worker `load_skill` tool is intentionally disabled.

## Generic diagnosis and optional selection

The [diagnostic lifecycle](../workflows/runtime-and-workspaces.md) treats a canonical empty `domain_extensions` set as a first-class path. Root persists `[]`, prepares or restores the same managed worktree/session machinery, and still runs Codex App Server readiness. It resolves no extension assets, creates no placeholder `.agents/skills` hierarchy, and requires no synthetic “core” skill. Delegation instead tells generic Codex to use repository instructions and standard diagnostic capabilities and not infer or invoke an unselected domain skill.

Selected extensions are optional additive capabilities. The current production registry recognizes only `ckb`; EVM and multi-extension combinations in tests demonstrate extensibility, not installed capabilities. Root canonicalizes the set by validation, deduplication, and sorting, so zero, one, or several selected IDs use one generic Codex worker. The exact set is durable session identity: resume cannot silently switch between generic and extension-assisted diagnosis.

Package paths are host policy, never model input. When extensions are selected, their native-skill names must be globally valid and unique, and preparation fails closed for an unknown extension, missing package, missing `SKILL.md`, escaped source, duplicate skill name, normal file at the destination, broken/unexpected symlink, or path outside the assigned package/worktree. Empty skill selection is valid; it does not weaken source, worktree, preflight-response, or Codex runtime checks.

Do not expose extension selection in MCP or Temporal contracts. Root selects from its mounted/registered capabilities, and all outer callers remain on the shared [protocol](protocol-and-workpads.md).

## Adding a domain pack

1. Scaffold an Eve extension, for example `npx eve@latest extension init <domain>`.
2. Create `packages/<domain>-domain-pack/extension/` and declare it with `defineExtension` from `eve/extension`.
3. Add only domain-owned instructions, tools, skills, hooks, connections, and helpers.
4. Ship source plus compiled extension output and keep `eve` as a peer dependency, following the package’s authoritative `AGENTS.md` pattern.
5. Mount it from `/eve/agent/extensions/<domain>.ts`.
6. Register every package-owned native skill in Root’s fixed `/eve/agent/lib/diagnostics/domain-extensions.ts` registry.
7. Add lifecycle tests for canonical ID sets, unique skills, safe symlink creation/restoration, missing/conflicting assets, and prepared delegation order.
8. Add domain quality evaluations under `/eve/evals/<domain>/`, because they test this application’s Root-to-worker flow rather than the reusable package alone.

Do not add a domain-specific subagent by default. Generic Codex can diagnose with zero, one, or several selected domain extensions without coupling capability to backend choice.

## Adding a consumer-owned worker

A new worker is justified only for a distinct runtime role, not as a domain packaging mechanism. Follow `/examples/add-custom-subagent/README.md`:

- declare `/eve/agent/subagents/<worker>/agent.ts` and its narrow instructions/tools;
- keep backend implementation under `/eve/agent/lib/backends/` and configuration under `/eve/config/workers/`;
- keep Root as the routing and aggregation surface;
- keep external contracts generic and prevent adapters from selecting the internal worker directly.

Any new worker must preserve [integration boundaries](../integrations/boundaries.md), public path privacy, Root-owned workpad/session reconciliation, and tests for process failure and durable replay semantics.

## Change checklist

- Does the change contribute capability only, or does it accidentally seize Root/session/provider authority?
- Are asset locations fixed by installed package policy rather than request/model paths?
- Can two selected extensions collide on a native skill name?
- Does Codex discover the skill in the assigned worktree without global copying?
- Are extension instructions authoritative and domain-specific rather than duplicated into Root?
- Do package unit tests and application-level diagnostic/evaluation tests cover the change?
