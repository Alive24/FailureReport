---
name: shea-symphony-manual-merge
description: Run a human-supervised Shea Symphony Merging Agent session for approved PR landing or bounded merge-lane recovery while preserving prior review and Human Review evidence.
---

# Shea Symphony Manual Merging Agent

Use this skill for operator-selected merge-lane diagnosis, repair, and landing. The Merging Agent owns existing PR recovery and merge execution. It does not take fresh Todo implementation or bypass Agent Review and Human Review.

For normal all-lane dogfood, prefer the configured foreground plan-and-run path. Use this manual route only for focused recovery or break-glass merge work.

## Bind and preflight

Resolve the active repository, workflow configuration, tracker project, Merge runtime/prompt, and supported issue, PR, workspace, claim, and merge actions. Do not assume paths, workflow files, prompts, or binaries.

Refresh workflow Project state and local runtime state. Read structured issue data, Doctor output, provider issue/PR views, Main Workpad, and append-only timeline evidence. Respect Merging Agent as the claim lock. Treat Main Agent as a do-not-touch signal except for explicitly merge-lane recovery.

A PR missing from closingIssuesReferences may still be linked: inspect the issue, Main Workpad, and timeline before concluding linkage is absent.

## Select only merge-lane work

Prefer, in order:

1. Merging issues with clean, approved PRs.
2. Merging issues whose mergeability, checks, linkage, or evidence needs diagnosis.
3. Historical or operator-selected merge-lane recovery already in Rework.

Select only if the status is Merging or eligible historical Rework, the claim is free or belongs to this session, a canonical linked PR can be identified, and Agent Review plus Human Review approval evidence exists. Missing evidence routes to Need Human Input; it is never assumed.

Do not claim fresh Todo implementation. Use $shea-symphony-manual-main for it.

## Recover and land

Clean, approved merges are workflow-owned and non-LLM: use the configured clean-merge action rather than starting an agent merely to press merge.

For a selected recovery:

1. Claim through Merging Agent and reuse the existing PR branch/worktree.
2. Repair stale base, conflicts, or merge-only failures without changing product scope.
3. Run focused verification, push the existing branch, and append merge evidence.
4. Continue toward landing only while the prior approvals remain valid.

Do not create a replacement feature branch unless the existing branch is unrecoverable and the operator explicitly agrees. Do not send a mechanical merge-lane repair back through Agent Review merely because it was rebased or a conflict was resolved.

For Merging status:

1. Confirm the PR is open, non-draft, linked, and has the expected base.
2. Confirm review and Human Review approval evidence.
3. Confirm clean checks and mergeability. If status is UNKNOWN, wait briefly and re-read before deciding.
4. If BEHIND, use the configured safe branch-update behavior and keep Merging for retry.
5. If dirty or conflicted, attempt safe repair in the trusted existing worktree. Ask for human input only for untrusted workspace evidence, semantic conflict, failed verification or push, or backend failure.
6. Merge using the repository's accepted method, append evidence, and reconcile the issue to Done.

Never delete the local PR branch during merge; explicit cleanup owns that later.

## Evidence, ordering, and boundaries

Write append-only Shea Symphony Merge Run timeline evidence. Do not edit, overwrite, or restructure the Main Agent Workpad.

Status routing is the final mutation: finish merge/recovery evidence and PR/issue reconciliation before Done or Need Human Input, then only read back and run Doctor verification.

- Never use the Main Agent field.
- Never merge without explicit approval evidence.
- Never hide unknown mergeability, missing linkage, or missing context.
- Never mark Human Review yourself as a substitute for an operator decision.
- Never change product scope in a merge-lane repair.
