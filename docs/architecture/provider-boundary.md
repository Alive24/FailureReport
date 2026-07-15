# Provider Boundary

> **Status: implemented MVP architecture.** Root and CKB use independently
> configurable factories; the only deliberate version boundary is the pinned
> community Codex App-server provider's LanguageModelV3 surface.

## Decision

FailureReport keeps Eve as the Root Supervisor and keeps CKB as an internal
declared subagent. The two tiers use different model-provider roles:

```text
MCP / Temporal / Codex plugin
            |
       Eve Root Supervisor
            |
   tool-capable Root provider
            |
       declared CKB subagent
            |
   Codex App-server provider
            |
 persistent Codex thread + isolated worktree
```

Only Root is public. Neither CKB nor a provider id becomes an MCP or Temporal
API.

## Root Provider

Root needs AI SDK custom-tool support. It must be able to call Issue workpad,
approval, routing, and declared-subagent tools, so its provider cannot ignore
the tools Eve supplies.

Local development uses Eve's `experimental_chatgpt()` helper. It reads
the local `codex login` credentials and acts as a normal, tool-capable AI SDK
model for Eve. A Root provider factory must make the model switchable later,
for example to a hosted OpenAI, Anthropic, or Gateway-backed model.

`experimental_chatgpt()` is experimental and depends on a local Codex login, so
it is a local-development default rather than an assumed production credential
strategy. A deployed Root must select an explicit tool-capable provider.

Do not use the Codex App-server provider as Root's model by default. The
provider is valuable for coding work, but it does not support AI SDK custom tool
schemas. Using it at Root would disable the mechanisms that make Root a
supervisor.

## CKB App-server Provider

CKB remains a declared Eve subagent with its own instructions, skills, config,
fixtures, and restricted tool surface. Its coding execution uses the
Codex App-server AI SDK provider configured with:

```text
cwd: assigned isolated worktree
threadMode: persistent
approvalMode: on-request
sandboxMode: workspace-write
```

The worker uses Codex-native shell and Git capabilities and any explicitly
configured MCP servers. CKB debugger scripts are reached through that worktree.
The CKB `load_skill` framework tool is explicitly disabled; do not expect
Eve-authored `tools/` to be available to an App-server-backed child.

The App-server provider's persistent session exposes a Codex thread id. The
system must retain that id so a later FailureReport resume can continue the
same coding conversation rather than recreate it from scratch.

## Worktree Ownership

Deterministic host code, not a model, owns worktree allocation and safety:

- Root's approval-gated `prepare_ckb_execution` allocates or validates an
  isolated worktree for a report and selected coding child.
- Keep the canonical checkout outside the worker's writable scope.
- The MVP uses one deterministic mutable CKB worktree per report. A future
  concurrent execution feature must add explicit leases or separate worktrees.
- Record branch, base revision, and current HEAD after each execution.

Codex owns the work **inside** its allocated worktree: repository inspection,
debugger execution, code edits, tests, and the evidence-backed conclusion.

## Durable State and Resume

GitHub Issue state remains the collaboration source of truth. The Issue body is
human-readable and one `failure-report-workpad` comment is the structured
snapshot.

The report has an optional typed `execution_state` rather than extending
the GitHub-specific `shared_context` object:

```ts
type ExecutionState = {
  backend_id: "codex_app_server";
  codex_thread_id?: string;
  worktree: {
    identity: string;
    path: string;
    branch: string;
    base_revision: string;
    head_revision: string;
  };
  last_execution_at?: string;
};
```

Before resuming a child, the CKB model factory reloads the workpad and validates
the worktree, repository origin, branch, base revision, and Git state. A missing
or unsafe worktree requires an explicit new execution or `needs_input`; never
silently fall back to the canonical checkout.

## Implementation Constraints

- Keep `RootRequest` and `RootResult` stable for MCP, Temporal, and Codex plugin
  callers.
- Keep adapters dependent only on `protocol` and `runtime-port`.
- Root owns Issue-write approval. The CKB model cannot write GitHub; a
  deterministic host journal persists its provider session metadata only inside
  a Root-approved execution.
- CKB stays internal and is selected only by Root.
- Wrap the community Codex App-server provider behind a local factory and pin its
  version. It is an integration dependency, not a new public contract.
- Tests cover protocol validation, MCP Root composition, worktree allocation and
  rejection paths, and Codex thread start/resume without a live model call.

## Verification

Use the CKBoost #54 fixture for a read-only end-to-end check:

1. Root publishes and approves a CKB-appropriate report through
   `prepare_ckb_execution`.
2. The child receives its allocated worktree and creates a Codex App-server
   thread.
3. The provider journal writes its thread id and final worktree HEAD to the
   workpad without allowing the CKB model to mutate GitHub.
4. A second call resumes the stored thread and worktree without creating a
   duplicate workpad comment.

Use #45 as the sparse-evidence case: the child should preserve uncertainty and
avoid inventing a diagnosis.

## References

- [Eve subagents](https://vercel.com/kb/guide/how-to-use-eve-subagents)
- [Codex CLI App Server provider](https://ai-sdk.dev/providers/community-providers/codex-app-server)
