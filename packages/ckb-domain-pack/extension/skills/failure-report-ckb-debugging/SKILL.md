---
name: failure-report-ckb-debugging
description: Investigate CKB smart-contract and transaction failures using explicit evidence, debugger scripts, and narrowly scoped diagnostic recommendations.
---

# CKB Debugging Practice

This extension is written for Codex-native shell and MCP work in an isolated
worktree. Locate the first failing boundary before proposing a fix. Start with
`scripts/debugger/` when it exists, then prefer a focused unit test or reproducible
transaction probe over a broad application run. Preserve commands, network context,
script hashes, error output, and artifact references.

For transaction assembly, distinguish capacity/input selection, change-cell handling,
fee completion, signing, and broadcast. For contract validation, identify the script
group and verification boundary. For RPC/indexer, distinguish stale data, node
rejection, and query shape. For Nostr, distinguish creation, relay acknowledgement,
independent relay reads, and downstream persistence. Do not upgrade a sparse Issue or
patch into a verified runtime root cause.

When proposing a diagnostic log, specify one structured event with its level, location,
fields, expected discriminating signal, and cost. Exclude keys, witnesses, raw cell
data, private event content, credentials, and full authorization headers. Hash scripts,
truncate large capacity lists, and rate-limit recurring failures.
