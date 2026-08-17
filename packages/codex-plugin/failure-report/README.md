# FailureReport Codex plugin

This is the installable, repository-local Codex plugin for FailureReport. It contributes two source-owned skills:

- `submit-failure-report` turns casual symptom language into a useful, privacy-safe GitHub Issue through adaptive evidence gathering, bounded experiments, duplicate checking, a complete preview, and explicit publication confirmation.
- `failure-report` creates, resumes, inspects, and hands off the later durable diagnosis through Root.

The plugin also configures one MCP server that exposes the public `failure_report` tool. GitHub Issue creation uses the participant's available GitHub integration or authenticated `gh` CLI; it does not require Eve, a FailureReport runtime, or a local checkout.

## Participant submission

A participant can start naturally, for example: “the first screen is slow” or “help me report this problem.” The submission skill asks only symptom-relevant questions, suggests a small number of safe checks when they would materially improve the report, and stops once another person can reproduce, compare, or continue the investigation.

Before any GitHub write, the skill searches for likely open duplicates, removes or redacts secrets, unrelated personal data, and private host paths, and shows the exact repository, title, and complete public body. Creating a new Issue or adding evidence to an existing one always requires explicit confirmation after that preview. If GitHub write access is unavailable, the skill returns copy-ready Markdown without claiming publication.

Submission and diagnosis are separate stages. After a successful Issue creation, starting FailureReport is optional and requires another explicit request. Participant submission never asks about checkouts, worktrees, branches, SHAs, Eve, MCP, ports, or local runtime configuration.

## Runtime composition

The plugin starts a generated, self-contained build of the outer `@failure-report/mcp-adapter` stdio wrapper from `mcp/server.mjs`. The bundle carries its JavaScript runtime dependencies inside the installed plugin, so it does not depend on the source repository or a pnpm workspace. The wrapper talks to FailureReport through Eve's built-in Channel; it does not embed another agent host or client under `eve/`. The only Eve entry remains [`eve/agent/channels/eve.ts`](../../../eve/agent/channels/eve.ts).

```text
Codex plugin (.mcp.json)
  -> @failure-report/mcp-adapter (stdio)
  -> private runtime supervisor (readiness + repository binding)
  -> Eve default Channel
  -> FailureReport Root
```

## Local use

Install the workspace dependencies and build the adapter from the repository root:

```bash
pnpm install
pnpm build
```

The installed adapter supervises Eve before it invokes Root. Ordinary reporters and Issue-selected diagnosis callers provide no checkout, runtime command, port, or process information. An operator privately selects one of two modes:

- `managed-local`: resolve an Issue repository through an operator-owned trusted mapping, verify its canonical Git origin, reuse a healthy matching Eve process, or start one through FailureReport's production entrypoint.
- `remote`: probe the configured deployment's health and authenticated repository binding. This mode never starts a local replacement.

For managed-local mode, configure the Codex host environment before the plugin starts. The checkout values are private host configuration and must never be copied into an Issue, workpad, report, prompt, or MCP request:

```bash
export FAILURE_REPORT_RUNTIME_MODE="managed-local"
export FAILURE_REPORT_TRUSTED_REPOSITORIES='{"repositories":[{"repository":"owner/repository","checkout":"/absolute/operator-owned/checkout"}]}'
```

The mapping is exact and path-free at the public boundary: Issue content can select only `owner/repository`, and it cannot add or override a checkout. The supervisor uses `pnpm --filter @Alive24/FailureReport start -- --target-workspace <trusted-checkout>` internally, waits for `/eve/v1/health` and the authenticated `/failure-report/v1/runtime` binding proof, and calls Root only after both match. Concurrent requests single-flight through private locks. State and redacted startup logs default beneath the operating user's state directory; `FAILURE_REPORT_RUNTIME_STATE_ROOT` may select an operator-managed private volume.

For `managed-local`, set `FAILURE_REPORT_RUNTIME_ROOT` to the operator-owned FailureReport source checkout that supplies the production Eve runtime; this private path is separate from both the installed plugin cache and the target repository checkout. Remote mode does not use a local runtime root. Optional operator settings are `FAILURE_REPORT_RUNTIME_STATE_ROOT` for owner-only state and logs, `FAILURE_REPORT_RUNTIME_READINESS_TIMEOUT_MS` for bounded startup, `FAILURE_REPORT_RUNTIME_POLL_INTERVAL_MS` for readiness polling, and `FAILURE_REPORT_RUNTIME_IDLE_TIMEOUT_MS` for managed-process cleanup. Values are milliseconds; an idle timeout of `0` disables cleanup.

Codex discovers installable plugins through configured marketplaces; it does not load an arbitrary plugin root directly. This repository intentionally contains no marketplace, so consumers should publish or configure a marketplace outside this bundle before installing it. Once installed, `.mcp.json` starts `node ./mcp/server.mjs` from the installed plugin root, so Codex receives the `failure_report` tool without access to this source workspace. Maintainers regenerate the committed artifact with `pnpm build:codex-plugin`; `pnpm check:codex-plugin` verifies that it matches the adapter and protocol sources.

For the repository's marketplace-free OpenSourceIRL demonstration, use the checked-in read-only MCP client after Eve starts:

```bash
pnpm --filter @failure-report/mcp-adapter demo:existing-issue -- Alive24/CKBoost 56
```

See the [demo runbook](../../../docs/demos/opensourceirl-2026-07-31-runbook.md) for exact runtime configuration and presentation order.

For a remote Eve deployment, pin both the host and repository identity:

```bash
export FAILURE_REPORT_RUNTIME_MODE="remote"
export FAILURE_REPORT_EVE_HOST="https://your-eve-host.example"
export FAILURE_REPORT_REMOTE_REPOSITORY="owner/repository"
export FAILURE_REPORT_EVE_BEARER_TOKEN="your-runtime-token"
```

The bearer token is optional only when the deployment's Eve Channel and runtime binding route permit the caller through another configured authentication path. Remote health, authentication, or binding failure returns operator-oriented pending guidance and never falls through to managed-local startup. For backward compatibility, an explicit `FAILURE_REPORT_EVE_HOST` with no mode is treated as remote, but new deployments should always set the mode and repository explicitly.

When provisioning, startup, readiness, or binding is unavailable, the adapter returns a sanitized category and retry guidance. It preserves the Issue and does not start a Root turn; after the operator repairs private provisioning, retry the same `request_id`. A runtime with an active diagnostic session is never stopped by idle cleanup. No credentials are stored in this plugin or its MCP config.

For adapter-only diagnostics outside Codex, run:

```bash
pnpm --filter @failure-report/mcp-adapter mcp
```

Use `submit-failure-report` for evidence collection and confirmed Issue publication. Use `failure-report` only for the separate durable diagnosis stage and its single public `failure_report` tool. The tool's Root contract remains the boundary: domain subagents and Eve internals are not MCP APIs.
