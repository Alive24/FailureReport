# OpenSourceIRL Demo Runbook — 31 July 2026

## Demo promise

Show one focused FailureReport Local Dogfood Alpha workflow:

```text
Existing CKBoost GitHub Issue
→ FailureReport bound to the CKBoost checkout
→ Eve Root reads the durable Issue workpad
→ evidence-backed diagnosis and diagnostic-only snapshot
→ deterministic human-readable implementation handoff
```

The demo does not implement the fix, create an implementation branch, or open a pull request.

## Where the demo starts

The executable Friday entrypoint is the repository's read-only MCP demo client:

```bash
pnpm --filter @failure-report/mcp-adapter demo:existing-issue -- Alive24/CKBoost 56
```

This is not a fixture or a direct GitHub script. It starts the actual `@failure-report/mcp-adapter` stdio server, calls its single `failure_report` tool, enters through Eve's default Channel, and asks Root to inspect the latest durable workpad. It performs no GitHub mutation.

The intended end-user entrypoint is the installable Codex plugin:

```text
$failure-report
→ failure_report MCP tool
→ Eve Channel
→ Root
```

Codex currently discovers installable plugins through configured marketplaces. The repository deliberately does not contain a marketplace and the plugin has not been installed into the presenter's personal environment. Unless that policy changes before Friday, use the repository MCP demo client as the live entrypoint and present the plugin bundle as the packaged distribution surface.

## Presentation surfaces

Prepare these before presenting:

1. A browser tab on [CKBoost Issue #56](https://github.com/Alive24/CKBoost/issues/56).
2. A browser tab on the [diagnostic snapshot branch](https://github.com/Alive24/CKBoost/tree/diagnostic/56-bug-campaign-start-end-times-do-not-update-correctly).
3. A browser tab on the [final implementation handoff](https://github.com/Alive24/CKBoost/issues/56#issuecomment-5104104249).
4. Terminal A running Eve.
5. Terminal B at the FailureReport repository root for the MCP demo client.

Keep the Issue tab initially positioned at the original failure report. Do not begin on the final handoff because the audience should first see the incomplete human symptom.

## Preflight

Run from normal macOS Terminal sessions with host access to the CKBoost checkout, Git credentials, the existing Codex home, and GitHub authentication. Do not launch Eve from a restricted app sandbox.

Required local state:

- Node.js 24 or later;
- pnpm 10;
- `gh auth status` succeeds;
- `codex login status` succeeds;
- FailureReport is on the demonstrated revision;
- CKBoost's `origin` resolves to `https://github.com/Alive24/CKBoost.git`;
- the immutable diagnostic revision `a2f98850862a8bc9ef9bb08c364ef6e8f03461a0` exists locally.

Verify the demonstrated FailureReport revision:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm format:check
```

Build Eve's production output without starting a watcher:

```bash
cd eve
pnpm exec eve build --skip-sandbox-prewarm
```

The watcher-based `pnpm dev` path is not required for this demonstration.

## Start FailureReport

In Terminal A, from `FailureReport/eve`, configure the GitHub producer and start the process-owned target:

```bash
export FAILURE_REPORT_GITHUB_WORKPAD_PRODUCER_ID="failure-report-local"
export FAILURE_REPORT_GITHUB_WORKPAD_PRODUCER_ACTOR_ID="$(gh api user --jq '.id')"
export FAILURE_REPORT_HANDOFF_DELIVERY_POLICY='{
  "schema_version": "failure-report/handoff-delivery-policy/v1",
  "repositories": [
    {
      "repository": "Alive24/CKBoost",
      "template": {
        "path": ".shea/template/failureReport/implementation.md"
      },
      "tracker": null
    }
  ]
}'
pnpm run demo:start -- --target-workspace "/absolute/path/to/CKBoost"
```

`demo:start` reuses the checked production build but gives Eve a fresh temporary app root. Its local Workflow World therefore cannot resume historical development or rehearsal runs from `FailureReport/eve/.eve`. It does not move, delete, or rewrite that directory.

Wait for both:

```text
Using isolated Eve workflow state at /tmp/failure-report-eve-demo-…/.eve
Listening on: http://127.0.0.1:2000/
```

This process is bound to CKBoost for its lifetime. Neither the MCP request nor the Issue can change that host path.

## Enter through MCP

In Terminal B, from the FailureReport repository root:

```bash
export FAILURE_REPORT_EVE_HOST="http://127.0.0.1:2000"
export FAILURE_REPORT_MCP_SESSION_STORE="/tmp/failure-report-opensourceirl-mcp.json"
pnpm --filter @failure-report/mcp-adapter demo:existing-issue -- Alive24/CKBoost 56
```

The expected concise output identifies:

- Root completion status;
- the CKBoost Issue URL;
- the authoritative workpad revision;
- current report status and confidence when Root includes the complete report;
- finalized diagnostic-session state;
- diagnostic snapshot branch;
- Ready handoff state.

Root may return only a concise summary and Issue binding for a read-only inspection. The durable browser views remain the product evidence.

## Eight-minute presentation flow

### 0:00 — Start with the human failure

Show the original CKBoost #56 narrative:

- changing only a campaign time appears accepted;
- reopening shows the old value;
- changing date and time appears to work.

Explain that an ordinary coding agent is tempted to propose a fix immediately, while FailureReport first creates a durable investigation.

### 1:00 — Enter FailureReport

Run the MCP demo command in Terminal B.

Point out the boundary:

```text
MCP client → failure_report → Eve Channel → Root
```

The caller supplies only `Alive24/CKBoost#56`; it does not provide a host path, worktree, branch, skill path, or backend.

### 2:00 — Show durable reasoning

Return to the Issue and show the latest human-readable workpad revision before opening folded JSON.

Highlight:

- repository evidence locating UTC `toISOString().slice(0, 16)` population;
- local-time parsing on submit;
- deterministic Europe/London DST probe;
- rejected downstream transaction/contract mutation hypothesis;
- high confidence and explicitly retained residual risks.

Explain that every revision is independently readable and the folded structured payload remains authoritative.

### 4:00 — Show the diagnostic snapshot

Open the diagnostic branch.

Explain:

- Root created and pushed it;
- it records the diagnostic session's immutable HEAD;
- it is not checked out as an implementation branch;
- nobody should develop directly on it or open a PR from it.

### 5:00 — Show the implementation handoff

Open the final handoff comment.

Show:

- goal and why now;
- scope in and scope out;
- guardrails;
- required outcomes;
- automated verification and UAT;
- diagnostic snapshot reference;
- residual risks;
- folded canonical handoff JSON.

State that CKBoost configured no Project routing, so the receipt has `tracker: null`. FailureReport created no implementation PR.

### 7:00 — Close with the product boundary

Summarize:

```text
FailureReport owns diagnosis and a bounded implementation contract.
The downstream coding workflow owns implementation, review, and merge.
```

## Live-write policy

The Friday presentation should be read-only after startup:

- do not start a second diagnosis on #56;
- do not append another Ready revision;
- do not redeliver unless idempotency itself is being demonstrated deliberately;
- do not edit or delete prior comments;
- do not change a tracker;
- do not create a PR.

The existing workpad, diagnostic branch, and handoff are already durable product outputs.

## Recovery

If the live inspect is slow or fails:

1. keep Terminal A visible to show the Eve boundary;
2. show the last successful MCP inspection output captured during rehearsal;
3. continue with the durable Issue workpad;
4. show the snapshot branch;
5. show the final handoff comment;
6. use the backup recording only for the original long-running diagnosis segment.

The product claim does not depend on replaying a long model turn live. Its value is the verified durable state left behind.

## Final rehearsal checklist

- [x] Full repository verification passes on the demonstrated revision.
- [x] Eve starts from a normal host terminal without a watcher.
- [x] The MCP demo command completes from a fresh adapter ledger.
- [x] The Issue shows a standalone human-readable authoritative revision.
- [x] The snapshot branch is reachable publicly.
- [x] The handoff comment is reachable and its structured JSON is folded.
- [x] No Issue comment, tracker state, branch, or PR changes during the rehearsal.
- [ ] Browser tabs, terminal font size, and window order are prepared.
- [ ] A screenshot or recording covers the long diagnostic segment.
- [x] The presentation can finish using only durable GitHub artifacts if the live model or network is unavailable.
