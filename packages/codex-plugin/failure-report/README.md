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

The plugin starts the outer `@failure-report/mcp-adapter` stdio wrapper. That wrapper talks to FailureReport through Eve's built-in Channel; it does not embed another agent host or client under `eve/`. The only Eve entry remains [`eve/agent/channels/eve.ts`](../../../eve/agent/channels/eve.ts).

```text
Codex plugin (.mcp.json)
  -> @failure-report/mcp-adapter (stdio)
  -> Eve default Channel
  -> FailureReport Root
```

## Local use

Install the workspace dependencies and build the adapter from the repository root:

```bash
pnpm install
pnpm build
```

Start Eve first, in a separate normal host terminal:

```bash
pnpm --filter @Alive24/FailureReport dev --target-workspace /absolute/path/to/target-checkout
```

That command runs `eve dev --no-ui`, whose documented local Channel endpoint is `http://127.0.0.1:2000`. Codex discovers installable plugins through configured marketplaces; it does not load an arbitrary plugin root directly. This repository intentionally contains no marketplace, so consumers should publish or configure a marketplace outside this bundle before installing it. Once installed, the plugin's `.mcp.json` starts `pnpm --filter @failure-report/mcp-adapter mcp` from the workspace root, so Codex receives the `failure_report` MCP tool automatically. With no `FAILURE_REPORT_EVE_HOST`, the adapter owns and uses that local endpoint. The plugin configuration deliberately declares only optional runtime environment variables; it does not embed a host or credentials.

For the repository's marketplace-free OpenSourceIRL demonstration, use the checked-in read-only MCP client after Eve starts:

```bash
pnpm --filter @failure-report/mcp-adapter demo:existing-issue -- Alive24/CKBoost 56
```

See the [demo runbook](../../../docs/demos/opensourceirl-2026-07-31-runbook.md) for exact runtime configuration and presentation order.

For a non-local Eve deployment, provide runtime environment variables to the Codex process before it starts the plugin:

```bash
export FAILURE_REPORT_EVE_HOST="https://your-eve-host.example"
export FAILURE_REPORT_EVE_BEARER_TOKEN="your-runtime-token"
```

`FAILURE_REPORT_EVE_HOST` overrides the adapter's local development default for non-local Eve deployments. The bearer token is optional and only needed when the Eve Channel requires it. No credentials are stored in this plugin or its MCP configuration.

For adapter-only diagnostics outside Codex, run:

```bash
pnpm --filter @failure-report/mcp-adapter mcp
```

Use `submit-failure-report` for evidence collection and confirmed Issue publication. Use `failure-report` only for the separate durable diagnosis stage and its single public `failure_report` tool. The tool's Root contract remains the boundary: domain subagents and Eve internals are not MCP APIs.
