# Gold Failure Report: CKBoost Issue #54

Fixture ID: `ckboost/issue-54-nostr-reliability` Schema target: `failure-report/v1` Fixture perspective: reconstructed after bounded diagnosis at the Todo-ready boundary, before implementation Last reconstructed: 2026-07-11

## Report State

- Status: `todo_ready`
- Domain pack: `ckb`
- Severity: high, submission-blocking
- Confidence in failure mode: high
- Confidence in application root cause: high
- Confidence in the reporter's exact browser/network trigger: medium
- UAT required: yes
- Original issue: https://github.com/Alive24/CKBoost/issues/54

This is a gold handoff, not a claim that the incident is closed. The issue remains open, and the available history does not include reporter confirmation that the replacement event could be loaded and edited successfully after deployment.

## Origin

- Sources: user-authored GitHub failure report and the original Codex diagnosis conversation
- Repository: `Alive24/CKBoost`
- Platform: CKBoost
- Campaign: Gone in 60ms: Fiber Network Infrastructure Hackathon
- Quest: Share project details
- First reported: 2026-07-09
- Environment: Chrome Desktop, connected CKB wallet, CKBoost showing `All synced`
- Sensitive artifact: the affected `nevent` is referenced in an issue comment and should not be duplicated into prompts or public derived artifacts unnecessarily.

## Observed Failure

A previously accepted submission initially displayed all eight saved responses. When the user later reopened the completed quest to edit it:

- CKBoost retained an on-chain submission reference;
- the referenced Nostr content could not be retrieved;
- all eight human-readable responses were unavailable;
- the UI exposed a Nostr event identifier where useful content was expected;
- the storage panel reported `Not Accessible`;
- repeated refreshes, reopening, waiting, and `Resubmit Content` did not restore durable access;
- the user could not reliably edit the active hackathon submission.

The failure is consistent and crosses sessions rather than being a single transient rendering error.

## Expected Behavior

For both initial submission and edits:

1. Submission content is published to the intended Nostr relay set.
2. CKBoost verifies independently readable, valid copies before reporting storage success or advancing the on-chain reference.
3. The on-chain reference and the retrievable off-chain content remain consistent.
4. A failed replacement does not destroy or supersede the last known valid reference.
5. Reopening or refreshing restores the saved answers and permits editing.
6. Existing inaccessible submissions have an explicit recovery path.
7. The UI distinguishes an absent event, an invalid event, and unavailable relays.

## Reproduction Contract

Preconditions:

- a wallet owns an existing quest submission;
- the user cell contains a Nostr event reference;
- the event cannot be retrieved from the relays CKBoost can access.

Steps:

1. Open the campaign and completed quest with the same wallet.
2. Load the existing submission.
3. Observe that the referenced event cannot be resolved into the original answers.
4. Attempt the recovery or resubmission action.
5. Refresh or reopen the quest.
6. Observe whether content remains accessible and editable.

A deterministic test fixture may replace public relays with controlled relay clients that acknowledge, reject, time out, return EOSE, or return invalid events.

## Evidence

### Observed Facts

- The original content was once accepted and displayed.
- An on-chain submission reference remained present when the content became inaccessible.
- CKBoost reported that the referenced Nostr event could not be retrieved.
- The resubmission action did not produce durable recovery for the reporter.
- The failure persisted after refresh, reopen, delay, and retry.
- Independent relay probes found the replacement event valid and complete with all eight responses on slower relays, while a faster relay returned empty and another relay failed to connect.
- The replacement event ID/hash, kind, and CKBoost event shape validated.
- CKB history contained one matching campaign/quest record and showed that the supplied replacement reference had successfully updated on chain.
- The replacement event was created after the issue opened, confirming that it came from the resubmission attempt.
- The previous persisted event contained eight subtask slots but only one non-empty answer; it cannot explain the reporter's memory of eight previously displayed answers.
- Pre-fix publication stopped after the first accepted relay but encoded unverified candidate relays into the `nevent`.
- Pre-fix retrieval could terminate on an early empty/EOSE result, and its retries reused the same request promise.

### Inferences Supported By The Facts

- CKBoost reached a partial-success state in which a valid replacement event and chain reference existed but browser retrieval was unreliable.
- A successful publish attempt or event ID alone was insufficient evidence of durable storage.
- The encoded relay hints overstated demonstrated redundancy.
- Write-side single-copy behavior and read-side early-completion behavior combined to make availability depend on which relay and network path won a race.

### Unknown At Handoff

- Why the reporter previously saw eight answers when the old persisted event held only one non-empty response.
- The exact browser/network condition that triggered the participant-side failure at that moment.
- Whether other users were affected.

## Hypotheses

| Hypothesis | Status at handoff | Required discrimination |
| --- | --- | --- |
| Publication established only one demonstrated copy while encoding additional unverified relay hints | Confirmed from source and relay probes | Fixed by per-relay publish plus read-back accounting |
| A fast empty/EOSE relay ended retrieval before a slower valid relay returned | Confirmed by response timing and pre-fix control flow | Fixed by independent requests that wait for a valid result or all terminals |
| Retry did not create a fresh network attempt | Confirmed from source | Fixed by new request per round |
| The replacement event was corrupt or invalid | Rejected | Event ID/hash, kind, shape, and content validated |
| Chain still referenced the old event or selected a duplicate record | Rejected | User-cell history showed one updated campaign/quest record |
| The reporter's browser could not reach the relay holding the copy | Supported trigger, exact condition unconfirmed | Requires affected-user or equivalent network UAT |

The first three faults form the confirmed application diagnosis. The final trigger remains an environment-level uncertainty and must not be overstated.

## Diagnosis

The replacement data was not lost: it was valid, contained all eight answers, and was referenced on chain. CKBoost nevertheless made it intermittently inaccessible because publication stopped after one accepted relay while the `nevent` advertised unverified candidates, and retrieval could let an early empty relay finish before a slower valid relay. The retry path did not perform a fresh request and collapsed distinct failures into a generic missing state.

The repair therefore requires this storage invariant:

> A submission reference may advance only after the exact signed event is valid and independently readable from the required relay quorum.

The product also needed a recovery invariant:

> Failure to validate a replacement must leave the previous durable reference unchanged and must expose a recoverable state rather than another success state.

The exact user-network trigger remains uncertain, but the application faults are supported by live per-relay evidence, chain history, and pre-fix source inspection.

## Todo Handoff

### Goal

Make Nostr-backed quest submissions fail safely, remain diagnosable, and recover from inaccessible historical events without allowing an unverified replacement to become the durable submission reference.

### Required Outcomes

- Publish to an explicit configured write-relay set.
- Validate the event before publication.
- Read back and validate the exact event independently from the required number of distinct relays.
- Do not finalize the CKB transaction when quorum is not reached.
- Preserve the existing on-chain submission reference on failed storage or verification.
- Treat duplicate publish rejection followed by valid read-back as success.
- Distinguish `event_absent`, `relay_unavailable`, and `invalid_event` in structured diagnostics.
- Do not render a raw event identifier where recovered human-readable submission content or an explicit recovery state belongs.
- Provide a bounded recovery/backfill path for historical inaccessible events.
- Keep repair attempts retryable and do not mark a relay repaired until read-back succeeds.
- Prevent read-discovered or event-advertised relays from silently becoming write targets.
- Preserve enough local evidence to recover from transient relay failures where the exact signed event is available.
- Keep Nostr relays as the only persistent event store. Local validated cache and repair tasks are allowed; centralized persistent copies are not.
- Apply stricter quorum policy to durable submission-class events without silently changing existing single-copy availability semantics for comments and likes.

### Guardrails

- Do not sign or broadcast arbitrary transactions as part of diagnosis.
- Do not expose wallet addresses, private keys, or private submission content in logs, Issues, or fixtures.
- Do not treat a publish ACK as proof of readable persistence.
- Do not treat timeout or aborted requests as proof that an event is absent.
- Do not replace a valid old reference until the candidate event passes the full verification gate.
- Do not claim recovery of the reporter's eight answers without direct evidence.
- Do not persist signed submission events to Netlify Blobs, a database, or another centralized recovery service.
- Do not execute public-relay repair or backfill without explicit authorization.

### Verification

Automated verification must cover:

- quorum success only from distinct validated read-backs;
- quorum failure before chain submission;
- duplicate publish plus valid read-back;
- fast empty relay versus slower valid relay;
- fresh queries across retry rounds;
- EOSE-confirmed absence versus timeout/unavailability;
- rejection of invalid or non-CKBoost events;
- write targets isolated from read-opened relays;
- submission quorum policy isolated from generic social-event policy;
- repair queue deduplication, retry, and read-after-write completion;
- exact signed-event backfill and tamper rejection;
- cache hit validation and tampered-cache eviction;
- campaign/quest-specific submission-record updates.

Human UAT must confirm:

- the affected submission or a controlled equivalent can be recovered;
- all saved fields render after refresh and a new session;
- an edited submission remains retrievable;
- failed replacement leaves the previous reference unchanged;
- errors present an actionable recovery path without showing a misleading success.

## Historical Outcome Reference

The subsequent implementation is recorded in:

- `28fa51fb1f9885ac4adef00b51e9fa5a3923c00d`: initial reliability hardening;
- `fe8d8bda0d12ac810d8a750e13ef922186f812d4`: regression prevention;
- `a2f98850862a8bc9ef9bb08c364ef6e8f03461a0`: fetch diagnostics.

These commits validate that a normal-sized Failure Report can drive a broad repair. They are evidence for the fixture evaluator, not requirements to reproduce the same file-by-file patch.

The investigation and human decision trail is summarized in [`conversation-evidence.md`](conversation-evidence.md).
