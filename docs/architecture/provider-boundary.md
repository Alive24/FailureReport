# Provider Boundary

> **Status: implemented MVP architecture.** Eve Root, the mounted CKB extension,
> and the consumer-owned Codex worker have deliberately separate responsibilities.

## Decision

FailureReport keeps Eve as the public Root Supervisor. CKB is a reusable Eve
extension, while the application owns the generic Codex App-server worker that
executes a Root-prepared coding task.

```text
MCP / Temporal / Codex plugin
            |
     outer ecosystem wrapper
            |
  Eve default HTTP Channel
            |
       Eve Root Supervisor
            |
   tool-capable Root provider
            |
  mounted CKB Eve extension
            |
 consumer-owned Codex worker
            |
   Codex App-server provider
            |
 persistent Codex thread + isolated worktree
```

Only Root is public, through the default Eve Channel at
`eve/agent/channels/eve.ts`. Neither an extension namespace, a domain id, a
worker name, nor a provider id becomes an MCP or Temporal API.

## Root Provider

Root needs AI SDK custom-tool support. It must be able to call Issue workpad,
approval, routing, and declared-subagent tools, so its provider cannot ignore the
tools Eve supplies.

FailureReport's MVP is intentionally local-first. Eve's experimental_chatgpt()
helper reads the local codex login credentials and acts as the default,
tool-capable AI SDK model for the product runtime; it is not just a development
or test convenience. A Root provider factory keeps a remote deployment
switchable later, for example to a hosted OpenAI, Anthropic, or Gateway-backed
model.

Do not use the Codex App-server provider as Root's model by default. The provider
is valuable for coding work, but it does not support AI SDK custom tool schemas.
Using it at Root would disable the mechanisms that make Root a supervisor.

## CKB Extension

packages/ckb-domain-pack/extension/ owns CKB-specific instructions, the
ckb-debugging skill, diagnostic helpers, and tools. The application mounts the
package at agent/extensions/ckb.ts, so Eve composes its capabilities under the
ckb__ namespace:

```text
ckb__prepare_execution
ckb__recommend_log
ckb__ckb-debugging
```

The extension's approval-gated ckb__prepare_execution tool accepts CKB request
data, invokes the consumer-injected execution preparer, and appends CKB guidance
to the returned delegation message. The mount supplies application policy — the
backend id and worktree root — without moving CKB instructions into the app.

This boundary follows Eve's extension rules: an extension may contribute tools,
connections, skills, instructions, hooks, and shared lib code, but cannot declare
agent.ts, a sandbox, schedules, limits, or nested extensions. It also does not
compose an extension-local declared subagent. Those concerns stay with the
consuming application.

## Codex App-server Worker

agent/subagents/codex/ is the application-owned worker. Its dynamic model is the
Codex App-server AI SDK provider configured with:

```text
cwd: assigned isolated worktree
threadMode: persistent
approvalMode: on-request
sandboxMode: workspace-write
```

The worker uses Codex-native shell and Git capabilities and any explicitly
configured MCP servers. Domain guidance is carried in the Root-prepared
delegation message. The worker's load_skill framework tool is explicitly
disabled; do not expect Eve-authored tools to be available to an
App-server-backed worker.

The App-server provider's persistent session exposes a Codex thread id. The
system retains that id so a later FailureReport resume can continue the same
coding conversation rather than recreate it from scratch.

## Execution and Worktree Ownership

Deterministic application-owned execution infrastructure, not a model, owns
worktree allocation and safety. A mounted extension identifies the domain and
supplies the instruction layer; the application host owns the worktree manager,
Issue workpad gateway, and provider policy:

- Root publishes the current report, then invokes the extension's approval-gated
  preparation tool such as ckb__prepare_execution.
- The application host allocates or validates the isolated worktree and persists
  execution state before the extension returns a delegation message.
- Keep the canonical checkout outside the worker's writable scope.
- The MVP uses one deterministic mutable CKB worktree per report. A future
  concurrent execution feature must add explicit leases or separate worktrees.
- Record branch, base revision, and current HEAD after each execution.

Codex owns the work **inside** its allocated worktree: repository inspection,
debugger execution, code edits, tests, and the evidence-backed conclusion.

## Durable State and Resume

GitHub Issue state remains the collaboration source of truth. The Issue body is
human-readable and one failure-report-workpad comment is the structured
snapshot.

The report has an optional typed execution_state rather than extending the
GitHub-specific shared_context object:

```ts
type ExecutionState = {
  domain_id: string;
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

Before resuming the worker, generic execution infrastructure reloads the workpad
and validates the worktree, repository origin, branch, base revision, and Git
state. The generic Codex model factory then resumes its provider session. A
missing or unsafe worktree requires an explicit new execution or needs_input;
never silently fall back to the canonical checkout.

## Implementation Constraints

- Keep RootRequest and RootResult stable at every outer boundary. An MCP or
  Temporal host may use `eve/client` to call the default Eve Channel, but must
  never import `eve/agent`, a domain extension, or a provider implementation.
- Root owns Issue-write approval. The Codex worker cannot write GitHub; a
  deterministic host journal persists its provider session metadata only inside
  a Root-approved execution.
- Domain extensions stay internal and are selected only by Root.
- Wrap the community Codex App-server provider behind a local factory and pin its
  version. It is an integration dependency, not a new public contract.
- Tests cover protocol validation, extension compilation, worktree allocation and
  rejection paths, and Codex thread start/resume without a live model call.

## Verification

Use the CKBoost #54 fixture for a read-only end-to-end check:

1. Root publishes and approves a CKB-appropriate report through
   ckb__prepare_execution.
2. The extension returns a CKB-guided delegation after the consumer host has
   prepared the allocated worktree.
3. The codex worker receives that exact delegation and creates a Codex
   App-server thread.
4. The provider journal writes its thread id and final worktree HEAD to the
   workpad without allowing the worker to mutate GitHub.
5. A second call resumes the stored thread and worktree without creating a
   duplicate workpad comment.

Use #45 as the sparse-evidence case: the worker should preserve uncertainty and
avoid inventing a diagnosis.

## References

- [Eve extensions](https://eve.dev/docs/extensions)
- [Codex CLI App Server provider](https://ai-sdk.dev/providers/community-providers/codex-app-server)
