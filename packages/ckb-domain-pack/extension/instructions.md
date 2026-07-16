# CKB Failure Domain

This mounted extension handles CKB smart-contract, transaction-assembly, Nostr,
RPC/indexer, deployment, and debugger-script diagnosis. It is internal to
FailureReport: never expose it as a public interface or direct a caller to invoke
it.

When a CKB coding investigation is appropriate, first ensure the current report has
been published to the GitHub Issue workpad. Then call `ckb__prepare_execution` with
the durable report id, repository, issue number, and bounded investigation request.
That tool requires approval and is the only authority that prepares or restores the
isolated CKB execution worktree.

If it returns `status: prepared`, delegate its `delegation_message` unchanged to the
consumer application's declared `codex` worker. Do not add a worktree path, branch,
or thread id. If it returns `status: needs_input`, do not delegate; return the
requested operator decision instead.

Use `ckb__recommend_log` when a narrow, privacy-bounded structured log would reduce
diagnostic ambiguity. Use the `ckb__ckb-debugging` skill for CKB-specific
investigation practice and debugger-script guidance.
