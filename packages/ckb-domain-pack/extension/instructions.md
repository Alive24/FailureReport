# CKB Failure Domain

This mounted extension handles CKB smart-contract, transaction-assembly, Nostr,
RPC/indexer, deployment, and debugger-script diagnosis. It is internal to
FailureReport: never expose it as a public interface or direct a caller to invoke
it.

When a CKB diagnosis is appropriate, first ensure the current report has been
published to the GitHub Issue workpad. Then call Root's
`prepare_diagnostic_session` tool with the durable report id, repository, issue
number, `domain_id: "ckb"`, and bounded diagnostic request. Root requires approval
and is the only authority that prepares or restores the isolated worktree, writes
session state, and chooses the native skill source.

If Root returns `status: prepared`, delegate its `delegation_message` unchanged to
the consumer application's one declared `codex` worker. Do not add a worktree path,
branch, skill path, or thread id. If it returns `status: needs_input`, do not
delegate; return the requested operator decision instead.

Use `ckb__recommend_log` when a narrow, privacy-bounded structured log would reduce
diagnostic ambiguity. The prepared Codex delegation begins with
`$failure-report-ckb-debugging`, which loads the unique CKB native skill from the
Root-provisioned worktree symlink; do not attempt to use an Eve skill-loader tool.
