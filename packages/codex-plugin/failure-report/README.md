# FailureReport Codex plugin

This is the installable, repository-local Codex plugin for FailureReport. It
contributes the `failure-report` skill and configures one MCP server that exposes
the public `failure_report` tool.

## Runtime composition

The plugin starts the outer `@failure-report/mcp-adapter` stdio wrapper. That
wrapper talks to FailureReport through Eve's built-in Channel; it does not embed
another agent host or client under `eve/`. The only Eve entry remains
[`eve/agent/channels/eve.ts`](../../../eve/agent/channels/eve.ts).

```text
Codex plugin (.mcp.json)
  -> @failure-report/mcp-adapter (stdio)
  -> Eve default Channel
  -> FailureReport Root
```

## Local use

Install the workspace dependencies and build the adapter from the repository
root:

```bash
pnpm install
pnpm build
```

Start Eve first, in a separate terminal:

```bash
pnpm --filter @Alive24/FailureReport dev
```

Then load this plugin from `packages/codex-plugin/failure-report`. Its `.mcp.json` starts
`pnpm --filter @failure-report/mcp-adapter mcp` from the workspace root, so
Codex receives the `failure_report` MCP tool automatically. The plugin is kept
inside this repository because that command intentionally invokes the outer
workspace adapter.

For a non-local Eve deployment, provide runtime environment variables to the
Codex process before it starts the plugin:

```bash
export FAILURE_REPORT_EVE_HOST="https://your-eve-host.example"
export FAILURE_REPORT_EVE_BEARER_TOKEN="your-runtime-token"
```

`FAILURE_REPORT_EVE_HOST` defaults to `http://127.0.0.1:3000`; the bearer token
is optional and only needed when the Eve Channel requires it. No credentials are
stored in this plugin or its MCP configuration.

For adapter-only diagnostics outside Codex, run:

```bash
pnpm --filter @failure-report/mcp-adapter mcp
```

Use the `failure-report` skill to form requests for the single public
`failure_report` tool. The tool's Root contract remains the boundary: domain
subagents and Eve internals are not MCP APIs.
