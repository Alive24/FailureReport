---
name: shea-symphony-manual-merge
description: Land one operator-selected Shea Symphony Merging issue in the current task, including safe stale-branch refresh or merge-lane-only repair. Use after Agent Review, required Human Review, and UAT evidence are complete; preserve approvals, record append-only merge evidence, merge the existing PR, and route conservatively without turning merge repair into Main work.
---

# Shea Symphony Manual Merge

Operate one human-supervised Merge-lane issue. Merge owns landing and narrow
landing repair; it does not own fresh implementation, independent review, UAT,
or approval.

Prefer the repository's deterministic `merge once`/bounded merge loop for a
clean approved queue. Use this manual skill for an operator-named landing,
focused merge diagnosis, or safe merge-lane repair. Never bypass Review or
Human Review.

## Bind the active repository

From the target repository root:

1. Read `SHEA_SYMPHONY_APP_PROFILE_PATH` when set. Otherwise prefer
   `.shea/app-profile.local.json` over `.shea/app-profile.json`.
2. Resolve `workflow_path` and `cli_path`; otherwise prefer
   `.shea/workflows/shea-symphony.md` and `.shea/bin/shea-symphony`.
3. Resolve absolute paths and verify the CLI with `--help`.
4. Read the workflow repository, Project, base branch, workspace root,
   verification commands, Merge prompt, `merge_lane`, and accepted merge method.

```bash
SHEA_CLI="<absolute-cli>"
SHEA_WORKFLOW="<absolute-workflow>"
ISSUE="#<number>"
```

Never use a hard-coded repository path or substitute `cargo run` for the
repository-selected operational CLI.

## Targeted preflight

```bash
"$SHEA_CLI" project issue "$SHEA_WORKFLOW" "$ISSUE" --json
"$SHEA_CLI" project inspect "$SHEA_WORKFLOW" "$ISSUE" --lane merge
"$SHEA_CLI" workspace show "$SHEA_WORKFLOW" "$ISSUE"
```

Use targeted `gh issue view` and `gh pr view` to confirm the exact linked PR,
head/base, draft state, mergeability, checks, commits, and closing relationship.
Do not use global Project scans unless a concrete ambiguity requires one.

Proceed only when:

- status is `Merging`, or the operator explicitly selected a historical
  merge-lane recovery already recorded as such;
- the `Merging Agent` field is empty or belongs to this task;
- exactly one linked PR is identifiable and targets the expected base;
- Agent Review passed and required Human Review/UAT approval evidence exists;
- the PR/worktree/branch identity is unambiguous and trusted;
- no active Main or Review work still owns the Issue.

Missing approval, ambiguous scope, or an untrusted workspace is a hard stop.
Do not infer approval from tests, mergeability, or Issue status alone.

## Deterministic clean landing

When the selected Issue is the only eligible unclaimed `Merging` item, prefer
the CLI-owned single tick:

```bash
"$SHEA_CLI" merge once "$SHEA_WORKFLOW" --write
```

Read back the named Issue and PR immediately. If queue selection could choose a
different Issue, do not use this shortcut; claim the named Issue and operate it
manually as below.

## Manual claim and workspace

Choose a stable worker identity and claim only after all read-only gates pass:

```bash
"$SHEA_CLI" merge claim "$SHEA_WORKFLOW" "$ISSUE" \
  --worker "<stable-worker-id>" --source manual --write
"$SHEA_CLI" project issue "$SHEA_WORKFLOW" "$ISSUE" --json
```

Reuse the existing PR worktree whenever possible. If multiple candidates exist,
stop for operator choice. Adopt the selected clean worktree through:

```bash
"$SHEA_CLI" workspace adopt "$SHEA_WORKFLOW" "$ISSUE" \
  "<absolute-pr-worktree>" --write
"$SHEA_CLI" workspace show "$SHEA_WORKFLOW" "$ISSUE"
```

Do not implement in the canonical checkout or create a replacement feature
branch merely for convenience.

## Landing and repair

For a clean approved PR:

1. Re-read the PR and approval evidence immediately before merge.
2. Require open, non-draft, expected base, clean checks, and `CLEAN`
   mergeability. If GitHub reports `UNKNOWN`, wait briefly and re-read once.
3. Merge with the repository's accepted method.
4. Reconcile the merged PR and Issue state through readback.

For `BEHIND`, safely update the existing PR branch without rewriting history,
record evidence, and leave the Issue in `Merging` for a later retry.

For `DIRTY` or conflicts:

1. Require a trusted clean PR worktree and abort any interrupted merge state.
2. Attempt only a mechanical merge of the current target base.
3. If conflicts are narrow and semantic behavior is unchanged, resolve them in
   the existing PR branch, run focused plus configured verification, push, and
   preserve prior approval only when workflow freshness policy permits it.
4. If resolution changes product scope, tests fail, the worktree is dirty or
   untrusted, push fails, or approval freshness is uncertain, stop with one
   concrete `Need Human Input` question.

Do not send merge-lane-only repair back through Main or Agent Review solely
because the base advanced. Do not add feature behavior while resolving merge
conflicts.

## Evidence and final routing

Use the workflow's merge-run template when present. Append a standalone `Shea
Symphony Merge Run` timeline note containing:

- Issue, PR, branch/base, worker and run identity;
- Agent Review and Human Review/UAT evidence consulted;
- preflight mergeability/check state;
- any branch refresh or conflict repair and verification;
- merge command/result and merged commit;
- final reconciliation and residual risk.

Write timeline evidence through the configured surface:

```bash
"$SHEA_CLI" project timeline-comment "$SHEA_WORKFLOW" "$ISSUE" \
  "<merge-run.md>" --write
```

Finish evidence and PR/Issue reconciliation before changing Project Status.
Make the status transition the final mutation:

```bash
"$SHEA_CLI" project set-state "$SHEA_WORKFLOW" "$ISSUE" done --write
"$SHEA_CLI" project issue "$SHEA_WORKFLOW" "$ISSUE" --json
```

After a status change, perform readback only. Never delete the local PR branch
or worktree; cleanup belongs to the explicit Shea cleanup surface. Never claim
Todo work, use the Main Agent field, manufacture approval, force-push, hide
unknown mergeability, or mark `Done` without proven merge evidence.
