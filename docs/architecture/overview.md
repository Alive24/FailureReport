# Architecture Overview

> **Status:** Implemented for the MVP. See
> [Provider Boundary](provider-boundary.md) for the exact runtime contract.

## Single Public Entry

Eve Root is the only public agent. MCP, Temporal, and Codex integrations invoke
Root through RootInvoker. Root decides whether to call the internal CKB subagent.

## Shared Context

Once the target repository is known, Root creates or adopts one GitHub Issue in
that repository. Root preserves existing human text and upserts a marked,
stable FailureReport narrative block in the Issue body. One comment marked with
`failure-report-workpad` holds the full structured FailureReport snapshot.

The snapshot's `status` is the MVP lifecycle state. A host may project it to
Project V2 or labels, but that projection is not the source of truth and is not
implemented by the core adapter packages.

Root reloads the workpad before resume and compares revision plus Issue update time
before writing. The GitHub API does not offer this adapter a general transaction;
the publisher re-reads immediately before mutation and rejects a changed revision
or timestamp. Large or sensitive evidence remains an artifact reference.

## Root Supervisor

Eve remains the Root Supervisor: it owns public-session lifecycle, routing,
approval, result aggregation, and internal subagent delegation. Root must use a
tool-capable AI SDK language model because Eve's Issue, approval, and declared
subagent mechanisms are tools from the model's point of view.

For local Codex-login development, Root should use Eve's
`experimental_chatgpt()` model helper. It uses local `codex login` credentials
while retaining Eve's normal tool-calling loop. Root model selection belongs in
a small provider factory so a later deployment can select another tool-capable
provider without changing the Root protocol or adapters.

MCP, Temporal, and Codex plugin integrations continue to call Root through
`RootInvoker`. The MCP package remains transport-neutral and does not import
CKB or any provider implementation.

## Codex Coding Subagents

CKB remains a declared, internal Eve subagent. Its execution model is
the Codex App-server AI SDK provider, not a generic Root-owned investigation
tool. This gives the CKB worker a persistent Codex thread, worktree-local coding
tools, Codex MCP configuration, mid-execution injection, and streamed tool/file
activity.

The Codex App-server provider is deliberately **not** Root's provider. It does
not support AI SDK custom tool schemas, so using it for Root would prevent the
normal Eve tool and declared-subagent graph from working. The CKB child instead
uses Codex-native shell/MCP capabilities plus its scoped instructions and skills.

Each coding child receives an isolated worktree allocated by deterministic host
code after Root approval and workpad publication. The CKB dynamic model factory
rehydrates and validates that workpad state before it starts or resumes Codex.
The worker may inspect, modify, and test only inside that worktree. The canonical
checkout is never an implicit fallback.

## Durable Execution State

GitHub Issue body and workpad remain the shared collaboration truth. Codex
execution state is separate but is serialized inside the structured
`FailureReport`, not hidden in an Eve session:

```text
backend id
Codex thread id
worktree identity and path
branch, base revision, and current HEAD
last execution time
```

On resume, the CKB backend reloads the workpad, validates the assigned worktree,
branch, origin, base revision, and recorded Git HEAD, then resumes the matching
Codex thread. A missing or unsafe worktree becomes an explicit failure requiring
operator input; it must never silently redirect the worker to the canonical
checkout.

## Eve Discovery Notes

`agent/config/` and `agent/subagents/ckb/fixtures/` are intentional extension
directories, not Eve authored slots. Eve reports them as ignored during discovery;
the application explicitly imports isolated backend configuration JSON, and
fixtures are loaded by tests and evals. This keeps configuration and domain evaluation material
isolated without replacing Eve's standard instructions, skills, tools, or
subagent layout.
