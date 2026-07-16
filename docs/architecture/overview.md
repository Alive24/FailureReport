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

## GitHub Gateway

GitHub is a Root-owned internal integration, never a public CKB, MCP, or Temporal
API. Root tools use the narrow `GithubIssueGateway` port. The default factory
creates an `OctokitIssueGateway`, so Issue metadata/body reads, comment
pagination, narrative updates, and workpad comment writes all use GitHub's
official TypeScript SDK.

By default, the factory obtains the active `gh auth login` token once per Root
process with `gh auth token`, keeps it in memory, and supplies it to Octokit.
It does not use `gh api` for normal Issue I/O. This keeps existing local GitHub
CLI login convenient without requiring users to install a GitHub App. A direct
`GithubCliIssueGateway` remains available only when
`FAILURE_REPORT_GITHUB_GATEWAY=gh-cli` explicitly selects the legacy local
fallback or fixture-capture path.

Token and GitHub App installation modes are injected through runtime environment
configuration. GitHub App credentials are optional, and are the preferred model
for a centrally operated multi-user/self-hosted deployment where a shared
machine-local `gh` login is unsuitable. No credential material is protocol data,
workpad content, prompt context, logs, or fixtures.

Octokit does not create a GitHub-side compare-and-swap primitive. The gateway's
shared publisher retains FailureReport's application-owned write-before-reload
flow: it checks the report's workpad revision, reloads before mutation, compares
the Issue `updated_at` and marked-comment revision again, then rejects stale
writes before creating or updating the one workpad comment.

## Root Supervisor

Eve remains the Root Supervisor: it owns public-session lifecycle, routing,
approval, result aggregation, and internal subagent delegation. Root must use a
tool-capable AI SDK language model because Eve's Issue, approval, and declared
subagent mechanisms are tools from the model's point of view.

FailureReport is local-first in the MVP: Root uses Eve's
`experimental_chatgpt()` model helper as its default product runtime. It uses
the local `codex login` credentials while retaining Eve's normal tool-calling
loop. The upstream helper remains named `experimental_chatgpt()`, but it is not
a test-only path here. Root model selection belongs in a small provider factory
so a remote deployment can select another tool-capable provider without changing
the Root protocol or adapters.

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

Each coding child receives an isolated worktree allocated by generic,
Root-owned execution infrastructure after Root approval and workpad publication.
The CKB dynamic model factory rehydrates and validates that execution state
before it starts or resumes Codex.
The worker may inspect, modify, and test only inside that worktree. The canonical
checkout is never an implicit fallback.

## Durable Execution State

GitHub Issue body and workpad remain the shared collaboration truth. Generic
execution state is separate but is serialized inside the structured
`FailureReport`, not hidden in an Eve session:

```text
domain id
backend id
Codex thread id
worktree identity and path
branch, base revision, and current HEAD
last execution time
```

On resume, generic execution infrastructure reloads the workpad and validates
the assigned worktree, branch, origin, base revision, and recorded Git HEAD.
The selected domain backend then resumes its matching provider session. A missing
or unsafe worktree becomes an explicit failure requiring operator input; it must
never silently redirect the worker to the canonical checkout.

## Eve Discovery Notes

`agent/config/` and `agent/subagents/ckb/fixtures/` are intentional extension
directories, not Eve authored slots. Eve reports them as ignored during discovery;
the application explicitly imports isolated backend configuration JSON, and
fixtures are loaded by tests and evals. This keeps configuration and domain evaluation material
isolated without replacing Eve's standard instructions, skills, tools, or
subagent layout.
