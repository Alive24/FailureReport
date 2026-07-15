# Add A Domain Subagent

Create one directory below `apps/failure-report/agent/subagents/`:

```text
agent/subagents/<domain>/
  agent.ts
  instructions.md
  config/
    backend/policy.json
    prompts/
    handoffs/
  tools/
  skills/<domain>-debugging/SKILL.md
  fixtures/
```

`agent.ts` must default-export `defineAgent({ description, model })`. The
description is Root's routing surface. The child does not inherit Root tools,
instructions, skills, or configuration, so put domain reasoning and privileged
domain operations inside this directory.

Keep external contracts generic. MCP and Temporal receive `RootRequest`, never a
domain id. Root alone decides whether the domain subagent should be called and
aggregates its result back into the Issue-backed FailureReport.
