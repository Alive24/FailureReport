# FailureReport Codex Plugin

This plugin contributes a Codex skill that guides use of the public
`failure_report` MCP tool. It deliberately contains no domain subagent endpoint
and no embedded agent runtime.

The host must separately configure an MCP server backed by the FailureReport Root.
See `examples/mcp-host` for the Root-only host composition and the repository
architecture documentation for the transport contract.
