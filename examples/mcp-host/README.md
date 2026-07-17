# MCP Host

This outer wrapper exposes one MCP tool and calls FailureReport through Eve's built-in Channel. It does not import CKB or implement an agent loop.

1. Start Eve locally from `eve` with `pnpm dev`; this serves `eve/agent/channels/eve.ts` at `/eve/v1/session*`.
2. Build the workspace with `pnpm build` from the repository root.
3. Start the stdio MCP host with `pnpm --filter @failure-report/mcp-adapter mcp`.

Set `FAILURE_REPORT_EVE_HOST` for a deployed Eve Root and `FAILURE_REPORT_EVE_BEARER_TOKEN` when its eve channel requires bearer auth. The Codex plugin uses the resulting public `failure_report` tool only.

GitHub I/O remains inside Eve Root. Its default GitHub credential source is the active `gh auth login` identity, supplied once to Octokit; the MCP adapter never calls GitHub or CKB directly.
