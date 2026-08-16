---
name: shea-symphony-manual-main
description: Execute one operator-selected Shea Symphony Main-lane issue in the current task, including Todo implementation, explicitly authorized Backlog pickup, Main-lane Rework, resumable In Progress work, or adoption of one existing implementation PR. Use when the operator wants the agent to do the implementation and hand off at Agent Review rather than launch another task.
---

# Shea Symphony Manual Main

Execute one named Main-lane issue in this task. Inspect the live tracker, reuse
or adopt one safe issue worktree, implement or finish the accepted scope,
verify it, publish one ready PR, record the canonical Main workpad, and stop at
`Agent Review`.

Do not create another task or invoke the configured Main backend instead of
doing the work. Main never performs independent review, Human Review, or merge.

## Bind the active repository

From the target repository root:

1. Read `SHEA_SYMPHONY_APP_PROFILE_PATH` when set. Otherwise prefer
   `.shea/app-profile.local.json` over `.shea/app-profile.json`.
2. Resolve the profile's `workflow_path` and `cli_path`. If omitted, prefer
   `.shea/workflows/shea-symphony.md` and `.shea/bin/shea-symphony`.
3. Resolve both paths to absolute paths and verify the CLI with `--help`.
4. Read the workflow repository, Project, workspace root, base branch, prompts,
   verification commands, and any explicit target branch in the Issue.

Use the resolved values consistently:

```bash
SHEA_CLI="<absolute-cli>"
SHEA_WORKFLOW="<absolute-workflow>"
ISSUE="#<number>"
```

Never substitute `cargo run` or a hard-coded checkout for the repository's
selected operational CLI.

## Targeted preflight

Use issue-scoped reads:

```bash
"$SHEA_CLI" project issue "$SHEA_WORKFLOW" "$ISSUE" --json
"$SHEA_CLI" project inspect "$SHEA_WORKFLOW" "$ISSUE" --lane main
"$SHEA_CLI" forge validate --workflow "$SHEA_WORKFLOW" --issue "$ISSUE"
"$SHEA_CLI" workspace show "$SHEA_WORKFLOW" "$ISSUE"
```

Use targeted `gh issue view` and `gh pr view` only for raw content missing from
the workflow surface. Avoid routine whole-Project scans and global Doctor runs.

Proceed only when:

- status is `Todo`, Main-owned `Rework`, matching resumable `In Progress`, or
  the operator explicitly authorized a named Backlog fast path;
- the Main claim is empty or belongs to this task;
- blockers and native subissues are terminal or explicitly non-blocking;
- the Issue quality gate is `Ready` or `ReadyWithAssumptions`;
- scope, base branch, linked PR, and workspace identity are unambiguous.

Route incomplete contracts to Issue Forge or `Need to Clarify`. Route missing
credentials, samples, authority, or product decisions to `Need Human Input`.
Do not claim first and ask basic scope questions afterward.

## Claim and workspace

Inspect `git worktree list --porcelain`, the canonical Main workpad, linked PR,
branch, session, and runtime evidence before claiming. One Issue has one
implementation branch, one canonical worktree, and one PR.

Reuse an existing issue worktree when evidence is consistent. An isolated
current-task worktree may be adopted only when it is registered for this
repository, is not the canonical checkout, has no conflicting ownership, and
is clean for new work or consistently belongs to this Issue for resume.

Record the selected worktree before a live claim:

```bash
"$SHEA_CLI" workspace adopt "$SHEA_WORKFLOW" "$ISSUE" \
  "<absolute-worktree>" --write
"$SHEA_CLI" workspace show "$SHEA_WORKFLOW" "$ISSUE"
"$SHEA_CLI" main claim "$SHEA_WORKFLOW" "$ISSUE" \
  --worker "<stable-worker-id>" --source manual --write
```

Confirm the claim through targeted readback. Record readiness and ownership in
the canonical Main workpad, then make `In Progress` the phase's final status
mutation and read it back. Never implement in the canonical checkout.

### Existing implementation PR

When the accepted Issue explicitly adopts an existing PR:

1. Require exactly one named, open, ready PR whose scope matches the contract.
2. Resolve a clean local worktree for its exact head branch and adopt it.
3. Refresh it safely against the confirmed base without rewriting unrelated
   history or discarding existing commits.
4. Preserve the existing PR; do not open a replacement unless it is provably
   unrecoverable and the operator agrees.
5. Repair native linkage with the PR body when the target is the default branch.

### Operator-confirmed Backlog fast path

For a named Backlog Issue explicitly authorized for direct execution, validate
its current title/body at Todo grade, keep it in Backlog during implementation,
skip the normal Main claim, record the exception in the workpad, and move
directly to `Agent Review` only after every handoff gate passes.

## Execute

1. Read the Issue contract, workpad, timeline evidence, repository instructions,
   authoritative docs, current code, and relevant PR.
2. Update exactly one canonical Main workpad with an issue-specific checkbox
   plan before significant edits.
3. Implement only the accepted scope in the adopted issue worktree.
4. Add focused tests and required documentation.
5. Run the strongest repository-owned verification, including every configured
   workflow verification command when practical. Repair in-scope failures and
   rerun them.
6. Record changed files, verification commands/results, risks, compatibility
   notes, and any non-obvious boundary comments in the workpad.
7. Commit and push the issue branch.
8. Open or update one ready, non-draft PR against the confirmed base.

For a default-base PR, include `Closes #<issue>` and require targeted Shea
readback to expose the exact PR with `source=github_native`. For a non-default
base, follow the workflow's documented fallback rule only when explicitly
accepted; never describe fallback evidence as native linkage.

Write the workpad only through:

```bash
"$SHEA_CLI" project workpad "$SHEA_WORKFLOW" "$ISSUE" \
  "<workpad.md>" --write
```

The final workpad must identify the branch, worktree, workspace origin, commit,
PR, base, ready state, linkage source, verification, residual risk, and why
Main stops at `Agent Review`.

## Handoff boundary

Finish PR/workspace/workpad evidence first. Make the status transition the
final mutation:

```bash
"$SHEA_CLI" project set-state "$SHEA_WORKFLOW" "$ISSUE" agent_review --write
"$SHEA_CLI" project issue "$SHEA_WORKFLOW" "$ISSUE" --json
```

After the transition, perform readback only. Never review, approve UAT, claim a
Merging issue, merge the PR, delete the issue branch, overwrite other lane
evidence, or hide quota, permission, trust, or backend failures.
