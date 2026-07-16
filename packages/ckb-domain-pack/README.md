# CKB Domain Pack

This package is an Eve extension for CKB failure investigation. It owns CKB
instructions, skills, diagnostic helpers, and namespaced tools. A consuming Eve
agent mounts it at `agent/extensions/ckb.ts`, which exposes contributions such as
`ckb__prepare_execution` and `ckb__recommend_log`.

The extension deliberately does not declare an Eve agent, sandbox, schedule, or
subagent. Those are consumer-owned concerns. The consuming application supplies a
single `prepareExecution` callback at mount time; it allocates the verified worktree
and records durable execution state before this extension tells Root to delegate to
the application's generic Codex worker.

Build the extension with `pnpm --filter @failure-report/ckb-domain-pack build`.
