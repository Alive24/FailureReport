# OpenSourceIRL Demo Readiness — 31 July 2026

## Goal

Demonstrate a credible local FailureReport alpha at OpenSourceIRL on Friday, 31 July 2026.

The demo should show that FailureReport can take an existing GitHub Issue, supervise a real evidence-producing diagnosis, preserve the investigation as durable human-readable Issue context, publish a diagnostic-only snapshot branch, and produce a bounded implementation handoff for a downstream coding workflow.

The reference case is [Alive24/CKBoost#56](https://github.com/Alive24/CKBoost/issues/56).

## Demo scope

The Friday build is a **FailureReport Local Dogfood Alpha**:

```text
Existing GitHub Issue
→ FailureReport process bound to one target workspace
→ Eve Root supervision
→ Codex diagnostic worker with selected domain extensions
→ human-readable, structured workpad revisions
→ finalized diagnostic-only snapshot branch
→ human-readable implementation handoff comment
```

The demo does not need to:

- implement the production fix;
- create an implementation pull request;
- demonstrate a multi-repository FailureReport process;
- demonstrate an unattended downstream Shea Symphony implementation lane;
- demonstrate every Channel, Temporal deployment, or alternate backend;
- present the experimental trace side project as production functionality.

## Current position on 28 July

The core diagnostic value has already been demonstrated:

- CKBoost #56 has a current-protocol FailureReport workpad.
- The investigation identified a high-confidence first failing boundary in the campaign admin `datetime-local` round trip.
- Repository evidence and deterministic timezone probes explain the reported time-only reversion and date-change workaround.
- Downstream transaction and contract timestamp mutation were investigated and rejected as the primary cause.
- A remote diagnostic snapshot exists at [`diagnostic/56-bug-campaign-start-end-times-do-not-update-correctly`](https://github.com/Alive24/CKBoost/tree/diagnostic/56-bug-campaign-start-end-times-do-not-update-correctly).
- Eve Root, the generic Codex worker, the CKB domain extension, GitHub workpads, the Codex plugin, MCP wrapper, diagnostic finalization, and handoff rendering/delivery boundaries all exist in the repository.

The current readiness estimate is approximately **90–95% for a focused local alpha demonstration**. The core end-to-end path has succeeded; the remaining work is rehearsal, packaging, verification, and fallback preparation rather than product-scope expansion.

Use the [OpenSourceIRL demo runbook](opensourceirl-2026-07-31-runbook.md) for the exact startup, live entrypoint, presentation sequence, and recovery path.

## Critical path completed

The previously blocking CKBoost #56 lifecycle mismatch has been closed through FailureReport itself:

- Root re-entered the existing Issue and read its durable workpad.
- The exact reporter timezone and uncaptured live transaction were classified as non-material residual risks rather than assumption-dependent blockers.
- The report reached `todo_ready` with `gate_decision: Ready`.
- The diagnostic session and pushed diagnostic-only snapshot were preserved.
- The deterministic handoff was rendered from revision-bound durable state.
- Delivery created a new [human-readable implementation handoff comment](https://github.com/Alive24/CKBoost/issues/56#issuecomment-5104104249).
- The structured handoff remains folded after the human view.
- CKBoost #56 remained tracker-free and was not added to FailureReport's Project.
- FailureReport created no implementation branch or pull request.

```text
finalized diagnosis
→ Ready implementation contract
→ deterministic handoff rendering
→ new human-readable Issue comment
```

The handoff is understandable without opening the folded structured JSON, while the structured payload remains available as the authoritative representation.

## Remaining demo work

- Prepare screenshots or a short recording for the original long-running diagnosis.
- Prepare the browser tabs, terminal font size, and window order on the presentation machine.
- Refresh OpenWiki only after authoritative code and documentation have stabilized.

The first complete read-only rehearsal passed on 28 July:

- Eve started from a clean, isolated local Workflow World with CKBoost as its fixed target workspace.
- The actual MCP stdio wrapper entered through the Eve Channel and inspected CKBoost #56.
- Root returned revision 7, `todo_ready`, a high-confidence diagnosis, the finalized diagnostic snapshot, and the delivered handoff.
- The Issue comment count remained 6 and the last comment remained `5104104249` before and after the rehearsal.
- The full build, type-check, test, and formatting suite passed.
- The snapshot branch and final handoff were read back from GitHub.

## Work plan

### Tuesday, 28 July — stabilize target workspace ownership

- Complete the single-process `--target-workspace` binding.
- Keep FailureReport's repository-root `.shea/` exclusively for developing FailureReport with Shea Symphony.
- Load immutable product defaults from `eve/config/failure-report/`.
- Copy only missing defaults into the bound target's `.shea` namespace.
- Keep target diagnostic worktrees under `.shea/worktrees/failureReport/`.
- Remove the multi-repository checkout registry and fallback source-cache behavior from the local MVP.
- Run the complete build, type-check, test, and formatting suite.

### Wednesday, 29 July — close the handoff lifecycle

- Completed: the finalized CKBoost #56 diagnosis reached a valid Ready implementation contract with non-material uncertainty preserved as residual risk.
- Completed: FailureReport rendered and delivered a new human-readable handoff comment without editing existing comments.
- Completed: the diagnostic branch remains a diagnostic-only snapshot.
- Completed: FailureReport created no PR or implementation branch.
- Completed: delivery was tracker-free for CKBoost #56.

### Thursday, 30 July — rehearse and package the demonstration

- Start FailureReport from a fresh process with CKBoost as the target workspace.
- Exercise the repository-local Codex plugin and MCP wrapper.
- Run the existing-Issue path without manually fabricating intermediate protocol state.
- Verify workpad reentry, diagnostic-session state, snapshot visibility, and the final handoff comment.
- Record the exact commands, expected visible checkpoints, and recovery steps.
- Prepare screenshots or a short backup recording in case live model, GitHub, or network latency is unsuitable.
- Refresh OpenWiki only after authoritative code and documentation have stabilized.

The repository-local MCP demo client is the guaranteed live entrypoint while the repository remains intentionally marketplace-free. The Codex plugin is the packaged end-user surface, but installing it in Codex currently requires a configured marketplace and remains outside the demo environment unless the operator explicitly changes that policy.

### Friday, 31 July — present the focused alpha

- Introduce the incomplete human failure report in CKBoost #56.
- Show FailureReport supervising evidence collection rather than immediately proposing a fix.
- Show the human-readable diagnostic history in the Issue.
- Show the diagnostic-only branch and explain why it is not an implementation branch.
- Show the final human-readable implementation handoff.
- State clearly that downstream implementation belongs to a separate coding workflow.

## Demo acceptance criteria

The Friday demo is ready only when all of the following are true:

- FailureReport starts with an explicit, validated target workspace.
- Public requests cannot provide or change a host path.
- The existing-Issue path rehydrates current Issue context without overwriting prior comments.
- Root creates or restores the target-local detached diagnostic worktree.
- Codex runs through the Root-prepared diagnostic session.
- The workpad presents useful human-readable revisions before folded structured data.
- The diagnosis contains attributable evidence, experiments, confidence, and residual uncertainty.
- Root pushes a visible `diagnostic/<issue>-<semantic-slug>` snapshot without checking it out as an implementation branch.
- A finalized, materially complete diagnosis produces a deterministic Ready handoff.
- Delivery creates a new human-readable Issue comment and does not edit an existing comment.
- The structured handoff remains available in a folded block.
- FailureReport creates no implementation PR.
- `pnpm build`, `pnpm check`, `pnpm test`, and `pnpm format:check` pass on the demonstrated revision.

## Presentation fallback

The demonstration should not depend on a single uninterrupted live model turn.

If live diagnosis is slow or unavailable:

1. show the existing Issue intake and current workpad;
2. explain the persisted session and reentry boundary;
3. show the verified diagnostic evidence;
4. show the remote diagnostic snapshot;
5. invoke or display the deterministic handoff boundary;
6. use the prepared recording only for the long-running diagnostic segment.

This fallback still demonstrates the product contract because the durable Issue, snapshot branch, and handoff are the product outputs; transient model animation is not.

## Scope freeze

Until the CKBoost #56 handoff path meets the acceptance criteria, new backlog work should not displace:

1. target-workspace stabilization;
2. finalized-to-Ready handoff completion;
3. one clean end-to-end rehearsal.

Additional Channels, multi-target hosting, remote workers, richer tracing, and downstream coding automation remain valuable follow-up work, but they are not required for the OpenSourceIRL alpha.
