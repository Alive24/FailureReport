# MCP Host

This composition keeps the adapter transport-neutral: the MCP process calls an
Eve HTTP Root through `RootInvoker`; it does not import CKB or implement an agent
loop.

1. Start the Eve Root locally from `apps/failure-report` with `pnpm dev`.
2. Build the workspace with `pnpm build` from the repository root.
3. Start the stdio MCP host with `pnpm --filter @failure-report/agent mcp`.

Set `FAILURE_REPORT_EVE_HOST` for a deployed Eve Root and
`FAILURE_REPORT_EVE_BEARER_TOKEN` when its eve channel requires bearer auth.
The Codex plugin uses the resulting public `failure_report` tool only.

GitHub I/O remains inside Eve Root. Its default GitHub credential source is the
active `gh auth login` identity, supplied once to Octokit; the MCP adapter never
calls GitHub or CKB directly.
