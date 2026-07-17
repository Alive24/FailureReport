# CKB Domain Pack

This package is an Eve extension for CKB failure investigation. It owns CKB
instructions, skills, diagnostic helpers, and namespaced tools. A consuming Eve
agent mounts it at `agent/extensions/ckb.ts`, which exposes contributions such as
`ckb__recommend_log` and the `ckb__failure-report-ckb-debugging` Eve skill.

The extension deliberately does not declare an Eve agent, sandbox, schedule, or
subagent. Those are consumer-owned concerns. It also has no consumer callback,
worktree tool, or provider configuration. FailureReport Root's
`prepare_diagnostic_session` tool selects this installed profile, creates or restores
the diagnostic worktree, and creates a worktree-local
`.agents/skills/failure-report-ckb-debugging` symlink to this package's native skill.
The one generic Codex worker then invokes `$failure-report-ckb-debugging` through
Codex-native skill discovery.

Build the extension with `pnpm --filter @failure-report/ckb-domain-pack build`.
