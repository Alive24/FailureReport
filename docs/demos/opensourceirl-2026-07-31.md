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

The current readiness estimate is approximately **75–80% for a focused local alpha demonstration**. The remaining work is concentrated in one end-to-end integration path rather than a broad feature build.

## Critical gap

CKBoost #56 currently exposes a lifecycle mismatch:

- the diagnostic session has been finalized;
- the diagnostic snapshot branch has been pushed;
- the report remains `diagnosed`;
- the handoff remains `not_ready` with a blocked gate;
- the Issue does not yet contain the final human-readable implementation handoff.

The demo is not ready until the following path succeeds through FailureReport itself:

```text
finalized diagnosis
→ Ready implementation contract
→ deterministic handoff rendering
→ new human-readable Issue comment
```

The handoff must be understandable without opening the folded structured JSON. The structured payload remains authoritative and should appear after the human-readable view.

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

- Make the finalized CKBoost #56 diagnosis reach a valid Ready implementation contract when no material unknown remains.
- Render and deliver a new human-readable handoff comment without editing existing comments.
- Preserve the diagnostic branch as a diagnostic-only snapshot.
- Confirm that no PR or implementation branch is created by FailureReport.
- Confirm tracker-free delivery for CKBoost #56 unless CKBoost explicitly configures its own Project routing.

### Thursday, 30 July — rehearse and package the demonstration

- Start FailureReport from a fresh process with CKBoost as the target workspace.
- Exercise the repository-local Codex plugin and MCP wrapper.
- Run the existing-Issue path without manually fabricating intermediate protocol state.
- Verify workpad reentry, diagnostic-session state, snapshot visibility, and the final handoff comment.
- Record the exact commands, expected visible checkpoints, and recovery steps.
- Prepare screenshots or a short backup recording in case live model, GitHub, or network latency is unsuitable.
- Refresh OpenWiki only after authoritative code and documentation have stabilized.

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
