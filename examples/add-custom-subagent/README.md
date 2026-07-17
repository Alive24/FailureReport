# Add A Consumer-owned Subagent

Use a declared subagent for a consumer-owned runtime role, such as a generic Codex execution worker. Do not use it as the packaging boundary for a domain: domain-specific capabilities belong in an Eve extension mounted from `agent/extensions/`.

```text
eve/
  agent/subagents/<worker>/
    agent.ts
    instructions.md
    tools/
    lib/                         # optional shared authored helpers
  config/workers/<worker>.json
  agent/lib/backends/<worker>-model.ts
  agent/extensions/<domain>.ts
  evals/<domain>/fixtures/
packages/<domain>-domain-pack/
  extension/
    extension.ts
    tools/
    skills/
    instructions.md
```

`agent.ts` must default-export `defineAgent({ description, model })`. The description is Root's routing surface. The child does not inherit Root tools, instructions, or skills, so give it only the generic runtime capabilities it needs inside its directory. Keep domain guidance in the mounted extension and pass it in the prepared delegation. Keep shared implementation helpers under `agent/lib/`; keep application configuration and fixtures in the sibling locations above so Eve's discovery tree remains canonical.

Keep external contracts generic. MCP and Temporal receive `RootRequest`, never a domain id. Root alone decides whether a mounted extension and its worker should be used and aggregates the result back into the Issue-backed FailureReport.
