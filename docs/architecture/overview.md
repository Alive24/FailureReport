# Architecture Overview

> **Status:** Implemented for the MVP. See
> [Provider Boundary](provider-boundary.md) for the exact runtime contract.

## Single Public Entry

Eve Root is the only public agent. Its primary entry is the built-in Eve HTTP
Channel declared at `eve/agent/channels/eve.ts`. MCP, Temporal, and Codex
integrations are outer packages or hosts that call that Channel; they never
become alternate agent roots. Root uses mounted domain extensions for
domain-specific routing, then delegates coding execution to an
application-owned worker.

## Shared Context

Once the target repository is known, Root creates or adopts one GitHub Issue in
that repository. Root preserves existing human text and upserts a marked, stable
FailureReport narrative block in the Issue body. One comment marked with
failure-report-workpad holds the full structured FailureReport snapshot.

The snapshot's status is the MVP lifecycle state. A host may project it to
Project V2 or labels, but that projection is not the source of truth and is not
implemented by the core adapter packages.

Root reloads the workpad before resume and compares revision plus Issue update
time before writing. The GitHub API does not offer this adapter a general
transaction; the publisher re-reads immediately before mutation and rejects a
changed revision or timestamp. Large or sensitive evidence remains an artifact
reference.

## GitHub Gateway

GitHub is a Root-owned internal integration, never a public extension, MCP, or
Temporal API. Root tools use the narrow GithubIssueGateway port. The default
factory creates an OctokitIssueGateway, so Issue metadata/body reads, comment
pagination, narrative updates, and workpad comment writes all use GitHub's
official TypeScript SDK.

By default, the factory obtains the active gh auth login token once per Root
process with gh auth token, keeps it in memory, and supplies it to Octokit. It
does not use gh api for normal Issue I/O. This keeps existing local GitHub CLI
login convenient without requiring users to install a GitHub App. A direct
GithubCliIssueGateway remains available only when FAILURE_REPORT_GITHUB_GATEWAY=gh-cli
explicitly selects the legacy local fallback or fixture-capture path.

Token and GitHub App installation modes are injected through runtime environment
configuration. GitHub App credentials are optional, and are the preferred model
for a centrally operated multi-user/self-hosted deployment where a shared
machine-local gh login is unsuitable. No credential material is protocol data,
workpad content, prompt context, logs, or fixtures.

## Root Supervisor

Eve remains the Root Supervisor: it owns public-session lifecycle, routing,
approval, result aggregation, and internal worker delegation. Root must use a
tool-capable AI SDK language model because Eve's Issue, approval, extension, and
declared-subagent mechanisms are tools from the model's point of view.

FailureReport is local-first in the MVP: Root uses Eve's
experimental_chatgpt() model helper as its default product runtime. It uses the
local codex login credentials while retaining Eve's normal tool-calling loop.
The upstream helper remains named experimental_chatgpt(), but it is not a
test-only path here. Root model selection belongs in a small provider factory so
a remote deployment can select another tool-capable provider without changing the
Root protocol or adapters.

The MCP package is an outer stdio wrapper that calls the default Eve Channel.
Temporal keeps its Workflow deterministic and uses a host-owned `RootInvoker`
inside its Activity; that invoker calls the same Channel. Neither wrapper imports
a domain extension or provider implementation.

## Domain Extensions and Codex Worker

CKB is a mounted, internal Eve extension. Its package owns CKB instructions,
skills, diagnostic helpers, and tool definitions; its mount at
agent/extensions/ckb.ts composes them as ckb__prepare_execution,
ckb__recommend_log, and ckb__ckb-debugging.

The extension cannot declare an agent config, sandbox, schedule, limits, nested
extension, or a composable declared subagent. FailureReport therefore owns the
generic Codex worker at agent/subagents/codex/. The worker's dynamic model
validates the Root-prepared execution envelope, rehydrates durable state, and
runs Codex App-server in the verified worktree. It receives CKB guidance in the
prepared delegation message rather than a hard-coded CKB prompt.

The Codex App-server provider is deliberately **not** Root's provider. It does
not support AI SDK custom tool schemas, so using it for Root would prevent the
normal Eve tool and declared-subagent graph from working. The worker instead uses
Codex-native shell/MCP capabilities.

Each coding task receives an isolated worktree allocated by generic,
application-owned execution infrastructure after Root approval and workpad
publication. The worker may inspect, modify, and test only inside that worktree.
The canonical checkout is never an implicit fallback.

## Durable Execution State

GitHub Issue body and workpad remain the shared collaboration truth. Generic
execution state is separate but is serialized inside the structured
FailureReport, not hidden in an Eve session:

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
The Codex model factory then resumes its matching provider session. A missing or
unsafe worktree becomes an explicit failure requiring operator input; it must
never silently redirect the worker to the canonical checkout.

## Eve Project Layout

eve/agent/ is an Eve-native agent directory. It contains only
the filesystem slots Eve owns and discovers:

```text
agent/
  agent.ts
  instructions.md
  channels/
    eve.ts
  lib/
    backends/
    execution/
    extensions/
    integrations/
      github/
  tools/
  skills/
  extensions/
    ckb.ts
  subagents/
    codex/
      agent.ts
      instructions.md
      tools/
```

The reusable CKB behavior lives in a distinct extension package:

```text
packages/ckb-domain-pack/
  extension/
    extension.ts
    instructions.md
    tools/
    skills/
    lib/
```

The `agent/lib/` subtree holds the Root runtime, generic execution host, and
GitHub integration as import-only authored helpers. Application configuration
and evaluation material remain siblings: `config/` holds Root and worker
configuration, while `evals/` holds evaluation definitions plus immutable
fixtures. This makes the Eve surface readable at a glance and prevents discovery
from silently ignoring product configuration or test data.

The outer `packages/` directory holds ecosystem packaging: `mcp-adapter/`
turns FailureReport into one stdio MCP tool, while `temporal-adapter/` supplies
the deterministic Workflow and Activity contract. Those packages reach the
Eve Channel over its HTTP API rather than living under `eve/`.
