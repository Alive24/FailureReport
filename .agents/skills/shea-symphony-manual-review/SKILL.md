---
name: shea-symphony-manual-review
description: Trigger one Shea Symphony review for a named issue through the external Review backend configured by the active repository workflow, including an explicitly authorized standalone implementation with one ready PR. Use when the operator wants a targeted independent review now; do not use the current agent to review the code or manufacture review evidence.
---

# Shea Symphony Manual Review

Launch exactly one operator-selected Review run through the repository's
configured external backend. This task is the launcher and, only when explicitly
authorized, the preparer of a safe standalone handoff. The external backend
owns diff inspection, judgment, evidence, and routing.

Never replace a failed external launch with a current-session review,
handwritten pass/reject evidence, or a fake backend.

## Bind the active repository

From the target repository root:

1. Read `SHEA_SYMPHONY_APP_PROFILE_PATH` when set. Otherwise prefer
   `.shea/app-profile.local.json` over `.shea/app-profile.json`.
2. Resolve `workflow_path` and `cli_path`; otherwise prefer
   `.shea/workflows/shea-symphony.md` and `.shea/bin/shea-symphony`.
3. Resolve absolute paths and verify the selected CLI with `--help`.
4. Read the workflow repository, Project, base branch, Review prompt,
   workspace root, and `review_lane` configuration.

```bash
SHEA_CLI="<absolute-cli>"
SHEA_WORKFLOW="<absolute-workflow>"
ISSUE="#<number>"
```

Do not invoke AGY, Gemini, Claude, Codex, or another reviewer directly. Shea
must launch the configured backend.

## External-backend gate

Require a real backend supported by the resolved CLI. Reject fake, fixture-only,
empty, or unknown backends. Let workflow validation enforce executable,
authentication, model, policy, sandbox, and transport requirements.

If the backend is unavailable, report its exact failure and the smallest
operator action. Do not fall back to local review.

## Targeted preflight

```bash
"$SHEA_CLI" project issue "$SHEA_WORKFLOW" "$ISSUE" --json
"$SHEA_CLI" project inspect "$SHEA_WORKFLOW" "$ISSUE" --lane review
"$SHEA_CLI" workspace show "$SHEA_WORKFLOW" "$ISSUE"
```

Use targeted `gh issue view` and `gh pr view` only for the named Issue and PR.
Confirm:

- status is `Agent Review`, unless the operator explicitly authorized the
  standalone fast path or a supported re-review;
- exactly one linked PR is open, ready, non-draft, and targets the expected base;
- Main handoff and canonical workspace evidence agree;
- no active Review claim or queued/running job owns the Issue;
- the workflow selects a supported non-fake external backend.

Do not use a whole-Project scan or all-lane loop for routine preflight. Stop on
ambiguous Issue, PR, workspace, claim, or backend identity.

For an ordinary native subissue, a passing review routes to `Merging`; the
parent owns final Human Review unless a recorded exception says otherwise.

## Standalone implementation fast path

Use this only when the operator explicitly asks to review a named implementation
that did not run through Main. Require:

- exactly one named or unambiguously associated open, ready PR;
- a clean worktree at the exact pushed PR head;
- the expected PR base;
- no terminal Issue state or active lane ownership;
- terminal/non-blocking dependencies and subissues;
- a passing external-backend gate.

Prepare the handoff through supported commands, in order:

```bash
"$SHEA_CLI" project link-pr "$SHEA_WORKFLOW" "$ISSUE" "#<pr>" --write
"$SHEA_CLI" workspace adopt "$SHEA_WORKFLOW" "$ISSUE" \
  "<absolute-worktree>" --write
"$SHEA_CLI" project issue "$SHEA_WORKFLOW" "$ISSUE" --json
"$SHEA_CLI" workspace show "$SHEA_WORKFLOW" "$ISSUE"
"$SHEA_CLI" project set-state "$SHEA_WORKFLOW" "$ISSUE" agent_review --write
"$SHEA_CLI" project issue "$SHEA_WORKFLOW" "$ISSUE" --json
```

Linkage and workspace evidence are the standalone equivalent of a Main
handoff. Preserve the assignee and do not manufacture a Main claim. The status
write is the final preparation mutation; after it, do readback only before the
review launch.

For a non-default-base PR, continue with workflow-recorded diagnostic linkage
only when explicitly accepted and targeted readback exposes exactly the named
PR as `fallback_diagnostic`. Never describe that as GitHub-native.

## Launch one review

Run exactly one configured backend:

```bash
"$SHEA_CLI" review once "$SHEA_WORKFLOW" "$ISSUE" --write
```

`review once` owns prompt rendering, claim lifecycle, backend launch, output
parsing, checklist updates, evidence, and routing. Do not separately call
`review claim`, `review pass`, `review reject`, `review fake`, or claim cleanup.
Do not inspect the diff to supplement or override the backend result.

## Read back

After the command returns, use only targeted readback:

```bash
"$SHEA_CLI" review status "$SHEA_WORKFLOW" \
  --issue "$ISSUE" --recent 3 --verbose
"$SHEA_CLI" project issue "$SHEA_WORKFLOW" "$ISSUE" --json
```

Report the backend, terminal job result, evidence location, resulting state,
and any durable launch failure. Never invent a review outcome, edit
implementation code, merge, force-push, mutate Project fields through raw
GraphQL, or retry authentication/configuration failures in a loop.
