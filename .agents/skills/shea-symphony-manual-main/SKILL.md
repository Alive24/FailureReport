---
name: shea-symphony-manual-main
description: Run one human-supervised Shea Symphony Main Agent implementation or Main-lane Rework session with a guarded claim, isolated workspace, evidence, PR, and Agent Review handoff.
---

# Shea Symphony Manual Main Agent

Use this skill for an operator-selected Main Agent implementation, Main-lane Rework, focused debugging, or break-glass recovery. The Main Agent owns code changes and stops at Agent Review; it does not approve, merge, or perform Human Review.

For normal all-lane dogfood, prefer the configured foreground plan-and-run path. This manual path must preserve the same claim, workspace, PR, evidence, and handoff semantics rather than becoming a looser parallel workflow.

## Bind and preflight

Resolve the active repository, workflow configuration, tracker project, Main runtime/prompt, and supported issue, worktree, PR, quality-gate, and routing actions. Do not assume paths, workflow names, prompts, or binaries.

Before selecting work:

1. Refresh workflow Project state and local runtime state.
2. Read the issue, current Main Workpad, timeline evidence, and relevant docs.
3. Respect the Main Agent Project field as the claim lock.
4. Check native blocked-by relationships and the issue quality gate.
5. Read provider issue and PR views as needed; use configured workflow surfaces for Project fields, claims, and state.

If the configured all-lane plan already selects the same issue and there is no reason to isolate Main, run the configured all-lane action from clean canonical main instead of creating a manual lane loop.

## Select only eligible work

Accept only:

- Todo issues that pass the quality and dependency gates;
- Rework issued by Agent Review findings or a Human Review contract revision that needs implementation; or
- In Progress work already claimed by this session or clearly resumable from its durable Main evidence.

For Rework, merge-only conflicts, stale-base repair, Merging failures, or an active Merging Agent claim belong to Manual Merge, not Main. A Forge Rework may recover missing PR or local worktree evidence inside the issue scope.

The issue is claimable only when:

- its Main Agent field is empty or belongs to this session;
- dependencies are terminal or explicitly non-blocking;
- its quality gate is Ready or ReadyWithAssumptions; and
- the contract is sufficient to implement without inventing product decisions.

A native parent is not claimable until every native subissue has Project status Done; GitHub closed alone is insufficient. Ordinary children still use Main and independent Agent Review, normally handing a review pass to Merging. The parent owns final Human Review and UAT unless a child declares a justified exception.

Route insufficient contract to Need to Clarify and missing external decisions, credentials, or samples to Need Human Input, with evidence. Do not claim first and investigate later.

## Implementation loop

For one selected issue:

1. Claim through the Main Agent field and create an isolated worktree and one feature branch, or safely resume the existing one.
2. Transition to In Progress only after the claim and initial evidence are durable.
3. Implement only the accepted scope.
4. Run the strongest practical verification for the touched area.
5. Update the durable Main Workpad and PR evidence.
6. Open or update one non-draft PR that links to the issue, preferably using a closing keyword.
7. Confirm the configured Project read surface exposes the linked PR and the provider reports it ready for review.
8. Hand off to Agent Review.

Use the configured app-server-first Main runtime when a runtime session is requested. A terminal-multiplexed backend is an explicit fallback/debug choice, not the default unattended path.

## Main Workpad and mutation order

Maintain exactly one canonical Main Agent Workpad in place. It contains:

- a pre-implementation Plan with issue-specific checkboxes;
- timestamped Work Log entries;
- changed files and scope boundary;
- verification commands and results;
- PR URL, linked-PR confirmation, and ready/not-draft state; and
- a handoff summary explaining why Main stops at Agent Review.

Main-lane Rework updates this same workpad with the current rework round. Review, Merge, Human Review, and Doctor evidence belongs in their own append-only timeline notes; never fold it into or replace the Main Workpad. Leave the issue body's review checklists for independent review.

Project status is the final mutation of each state-changing phase. Before In Progress, Need to Clarify, Need Human Input, or Agent Review, finish the claim, workspace/PR update, evidence, and linked-PR verification that justify it. After routing, only read back and run Doctor verification.

## Hard boundaries

- Never move work directly to Human Review or Done.
- Never merge a PR or use the Merging Agent field.
- Never bypass the quality or dependency gate.
- Never use a blocked issue as an implementation experiment.
- Never conceal usage-limit, trust, permission, or backend failures.
