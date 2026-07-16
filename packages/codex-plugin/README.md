# FailureReport Codex Plugin

This plugin contributes a Codex skill that guides use of the public
`failure_report` MCP tool. It deliberately contains no domain subagent endpoint
and no embedded agent runtime.

The host must separately configure the outer MCP wrapper, which calls
FailureReport through its default Eve Channel. See `examples/mcp-host` for the
composition and the repository architecture documentation for the transport
contract.
