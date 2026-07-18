# FailureReport

FailureReport is an Eve-supervised Failure in the Loop system. It turns an incomplete software failure into a durable, evidence-backed report whose shared context lives in one GitHub Issue from intake through Todo promotion.

> **Provider boundary:** FailureReport is local-first by default: Root runs Eve with `experimental_chatgpt()` from the local Codex/ChatGPT session. The mounted CKB extension supplies domain capability, while Root prepares a durable diagnostic worktree for the one consumer-owned Codex worker. See [provider boundary](docs/architecture/provider-boundary.md) for the contract.

## Core Model

```mermaid
flowchart TD
  M["MCP / Temporal / other external wrapper"] --> C["Eve Channel client"]
  C --> H["Eve default HTTP Channel"]
  H --> E["Eve Root Supervisor"]
  E --> R["Tool-capable Root model provider"]
  E --> X["CKB mounted Eve extension"]
  E --> I["GitHub Issue managed-comment workpad"]
  E --> D["Root prepare / finalize diagnostic session"]
  E --> B["Eve just-bash orchestration sandbox"]
  D --> W["Host-managed .eve/sandbox-cache source + detached worktree"]
  W --> C["Consumer-owned Codex worker"]
  C --> A["Host Codex App Server + existing Codex Home"]
```

- Eve Root is the only public supervisor. Its primary public entry is Eve's built-in HTTP channel, declared at `eve/agent/channels/eve.ts` and exposed as `/eve/v1/session*`.
- Root uses a **tool-capable** AI SDK model so Eve can retain Issue, approval, routing, and declared-subagent tools. The MVP runs locally by default, using Eve's `experimental_chatgpt()` helper with the signed-in Codex/ChatGPT session; this is the product default, not a test-only convenience. A remote host may opt into another tool-capable provider later.
- CKB is the first mounted Eve extension, never a public API target. It provides CKB instructions, the `failure-report-ckb-debugging` native skill, and deterministic `ckb__recommend_log`; it does not own a worktree, sandbox, or subagent.
- Root's always-approved `prepare_diagnostic_session` tool accepts a report bound to a repository and full immutable Git SHA, resolves a Root-selected non-empty `domain_extensions` set, and manages the source cache plus detached diagnostic worktree only under the repository's `.eve/sandbox-cache/`. It places every approved native skill under `.agents/skills/` and persists worktree/HEAD/Codex-thread state before delegating to the one `codex` worker. Codex decides how to use the loaded skills; extensions never select a backend.
- Root's separate always-approved `finalize_diagnostic_session` tool creates `failure-report/diagnostic/<identity>` only after the diagnostic worktree is clean. It does not check the branch out. The workpad labels it a diagnostic-only snapshot: future coding must use a separate implementation worktree/branch and must not open a PR directly from the snapshot.
- A target-repository GitHub Issue is shared context: FailureReport never edits its body or a foreign comment. A managed comment is trusted only when its marker, v2 entry envelope, configured producer identity, and live immutable GitHub author identity agree.
- Root owns GitHub as an internal integration. Octokit is the default API transport; by default it reuses the active local `gh auth login` identity once per process, then performs Issue and comment calls through the SDK.
- The workpad records an append-only logical lineage. The same verified producer appends a new immutable entry to its comment; a different configured producer creates a linked successor comment without modifying the predecessor. Any copied marker, malformed entry, unknown producer, conflicting lineage, or fork becomes `needs_input`.
- Codex App Server's `threadId`, assigned worktree identity, Git revision, and optional finalized diagnostic snapshot are durable `diagnostic_session` state, distinct from GitHub shared context.
- MCP and Temporal are outer packages that wrap the default Eve Channel for their own ecosystems; they do not create a second agent entry inside `eve/`.

## Workspace

```text
eve/agent                 Eve-discovered Root, Channel, tools, workers, and import-only authored helpers
eve/config                Application-owned Root and worker configuration
eve/evals                 Eve evaluations and immutable evaluation fixtures
packages/ckb-domain-pack  Reusable CKB Eve extension
packages/protocol         Zod schemas, Root invocation type, and workpad serialization
packages/mcp-adapter      MCP stdio wrapper that calls the default Eve Channel
packages/temporal-adapter Deterministic Temporal workflow and activities
packages/codex-plugin/failure-report  Installable Codex plugin and Eve-backed MCP configuration
examples/                 Extension and host examples
.eve/sandbox-cache/       Root-owned host source caches and detached diagnostic worktrees (runtime state)
```

`eve/agent/` is intentionally limited to Eve's filesystem slots: `agent.ts`, `instructions.md`, `tools/`, `skills/`, `extensions/`, `lib/` when shared authored code is needed, and declared `subagents/`. The Root runtime, generic diagnostic-session helpers, and GitHub integration now live under `agent/lib/`: they are import-only authored code and are never mounted into a worker workspace. Product configuration and evaluation material remain alongside `agent/`.

## Development

Node 24 and pnpm 10 are required.

```bash
pnpm install
pnpm build
pnpm check
pnpm test
```

To verify native Codex skill discovery locally without starting a model turn, run the opt-in App Server smoke test. It creates a temporary Git worktree, links the CKB skill beneath `.agents/skills`, and calls `skills/list` only:

```bash
FAILURE_REPORT_RUN_CODEX_APP_SERVER_SMOKE=1 pnpm --filter @Alive24/FailureReport test -- codex-native-skill.smoke.test.ts
```

FailureReport's MVP is a local product runtime. It uses the same `codex login` credentials in two distinct roles: a tool-capable Eve Root model via `experimental_chatgpt()`, and a Codex App Server provider for the diagnostic worker. The latter must be given an isolated worktree and must not be used as the Root model, because it does not support AI SDK custom tool schemas.

To use the public Root MCP surface through Codex, start Eve (and therefore its default Channel) in one terminal:

```bash
pnpm --filter @Alive24/FailureReport dev
```

Then load the repository-local Codex plugin at `packages/codex-plugin/failure-report`. Its `.mcp.json` starts the external `@failure-report/mcp-adapter` wrapper, which exposes the single `failure_report` tool and calls the default Eve Channel. `FAILURE_REPORT_EVE_HOST` can point that wrapper at a deployed Root; set `FAILURE_REPORT_EVE_BEARER_TOKEN` when the Eve Channel requires bearer auth.

For a local diagnosis, Root accepts only a repository identity and a full immutable Git SHA. It never accepts a source checkout path, cache path, worktree path, branch, or Codex `cwd`. Root derives the canonical remote, then manages this fixed host-owned hierarchy inside the FailureReport checkout:

```text
.eve/sandbox-cache/
  sources/<canonical-repository-cache>
  worktrees/<diagnostic-session>
```

The actual `git clone`, `git fetch`, `git worktree`, test, and package-manager commands run in the host runtime. Eve is pinned to `just-bash` for Root orchestration; its virtual shell is not a replacement Git runtime. Root's host-side diagnostics adapters inspect the controlled workspace and Codex App Server runs directly on the host with the validated worktree as `cwd`, retaining the user's existing `~/.codex`, plugins, skills, MCP settings, authentication, Git credentials, model configuration, and thread persistence. No path-setting environment variable is supported for this boundary.

## GitHub Runtime Authentication

Octokit is the GitHub API client; it does not require users to create or install a GitHub App. The default runtime path expects `gh` to be installed and logged in on the machine that runs Eve Root:

```bash
gh auth login
```

When Root first needs GitHub, it reads the active CLI credential with `gh auth token` once in that process, keeps it only in memory, and passes it to Octokit. All Issue and comment reads/writes then use Octokit, not `gh api`. This applies equally to local MCP and Temporal-backed Root execution; each Root host needs its own active `gh` login by default.

Diagnostic source acquisition is separate from the GitHub API client: Root runs `git clone` and `git fetch` through the host's ordinary Git runtime, only inside its Root-owned `.eve/sandbox-cache/sources/` cache. A public or private repository is supported whenever that runtime can reach and authenticate to the canonical remote. Configure ordinary host Git authentication externally; FailureReport never writes credentials into a report, workpad, plugin configuration, or log.

Runtime configuration is optional for that common path. These alternatives are available when a host cannot use a CLI login:

| Setting | Purpose |
| --- | --- |
| `FAILURE_REPORT_GITHUB_AUTH=token` + `GITHUB_TOKEN` | Inject a runtime token into Octokit. |
| `FAILURE_REPORT_GITHUB_AUTH=app` + `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | Use a GitHub App installation through Octokit. This is the preferred credential model for centrally operated multi-user or self-hosted deployments, but is never required for ordinary users. |
| `FAILURE_REPORT_GITHUB_GATEWAY=gh-cli` | Explicit legacy `gh api` fallback for local diagnostics or fixture capture; it is not the default transport. |
| `FAILURE_REPORT_GITHUB_HOST`, `FAILURE_REPORT_GITHUB_API_URL` | Select a `gh` host and/or GitHub Enterprise API base URL. |
| `FAILURE_REPORT_GITHUB_WORKPAD_PRODUCER_ID` + `FAILURE_REPORT_GITHUB_WORKPAD_PRODUCER_ACTOR_ID` | Required together to identify Root's current managed-comment producer with GitHub's immutable numeric actor ID. |
| `FAILURE_REPORT_GITHUB_WORKPAD_PRODUCERS` | Optional JSON object mapping every approved producer ID to its immutable GitHub actor ID, for example `{"root-gh":"101","root-app":"202"}`. |

All credentials belong in runtime environment/secret management only. FailureReport does not put tokens, App private keys, credential output, host-local paths, or raw private evidence into the public workpad, prompts, logs, or fixtures. Non-public evidence must be retained outside GitHub and referenced only through an opaque handle.

## Managed GitHub Workpads

Every public workpad entry carries a versioned envelope with its immutable producer, logical session, entry identity, revision, and any predecessor-comment reference. The concise status summary appears before a folded, schema-validated JSON snapshot. Root rehydrates only one valid linear lineage; it never migrates a legacy marker-only comment or guesses between candidates.

## Extend

Add a domain as an Eve extension, starting with `npx eve@latest extension init <domain>`. Keep its reusable capabilities in `packages/<domain>-domain-pack/extension/`: `extension.ts`, tools, skills, instructions, hooks, connections, and `lib/`. Mount it from `eve/agent/extensions/<domain>.ts`; its contributions compose under `<domain>__` names. Extensions cannot own an agent config, sandbox, schedules, or nested extensions, so the application retains diagnostic-session policy and one generic Codex worker under `agent/subagents/`. Register each extension's installed native skill assets in Root's fixed `domain_extensions` registry; Root then materializes safe `.agents/skills` symlinks for the selected set in each diagnostic worktree. Do not expose extension selection through MCP or Temporal. A Codex App Server worker must not rely on Eve-authored tools being callable by its model; the prepared delegation starts with all selected native `$skill` invocations and it uses shell, MCP, and worktree-scoped capabilities.

Add an external wrapper at `packages/<name>-adapter/`. It converts platform events into `RootRequest`, calls the default Eve Channel, and returns a `RootResult`. It must not import `eve/agent`, implement FailureReport business logic, or call a domain subagent directly. Temporal Workflow code remains deterministic; its Activity is the outer boundary that invokes the Channel.

See [architecture overview](docs/architecture/overview.md), [provider boundary](docs/architecture/provider-boundary.md), [custom subagents](examples/add-custom-subagent/README.md), and [Temporal host](examples/temporal-host/README.md) for the concrete extension points.
