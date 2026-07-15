# Conversation Evidence: CKBoost Issue #54

## Source Sessions

Primary implementation conversation:

`/Users/chuntengxiao/.codex/sessions/2026/07/10/rollout-2026-07-10T13-03-55-019f4be9-b4c8-7ff1-bdb0-b21d8b07cd6e.jsonl`

Related review/approval transcript:

`/Users/chuntengxiao/.codex/sessions/2026/07/10/rollout-2026-07-10T19-38-09-019f4d52-a4fb-7511-a5d6-faa7889601ef.jsonl`

These local records contain sensitive identifiers and submission content. This
digest preserves diagnostic facts and decisions while redacting the full `nevent`,
user type ID, public key, answers, and transaction hash.

## Why The Conversation Matters

The GitHub issue describes the product failure well, but the conversation records
the actual confidence loop:

```text
report
  -> inspect two application read paths
  -> query the same event per relay
  -> compare response timing and EOSE behavior
  -> inspect chain history and submission records
  -> inspect pre-fix publish/fetch source
  -> reject alternative causes
  -> propose reliability invariants
  -> implement
  -> review for regressions
  -> revise architecture and behavior
  -> add diagnostics and verify
```

Without this record, the fixture loses both its confirmed root cause and the human
decisions that shaped the final repair.

## Investigation Timeline

### Intake

The user supplied issue #54, the affected replacement `nevent`, the affected user
type ID, and an important asymmetry: the admin page could display event metadata
while the participant page could not load the submission. The user also supplied
an older report from another participant with similar retrieval symptoms.

### First Discrimination

The agent treated the admin-page visibility as evidence against immediate global
event loss and compared admin and participant retrieval paths.

It then queried the exact event independently on individual relays rather than
trusting an aggregator:

| Relay observation during investigation | Result                            |
| -------------------------------------- | --------------------------------- |
| `relay.damus.io`                       | valid event returned              |
| `relay.primal.net`                     | valid event returned              |
| `nos.lol`                              | explicit empty result             |
| `relay.nostr.band`                     | connection failure                |
| `relay.nostr.net`                      | empty result in the initial probe |

The valid event contained all eight responses, was 13,451 bytes, used kind 30078,
and passed event ID/hash validation. The empty relay responded in roughly 177 ms,
while valid relays responded later, around 238 to 465 ms.

This timing reproduced the read-side race: an early EOSE/empty result could end the
pooled request before a slower relay returned the valid event.

### Chain And History Check

The agent checked the CKB user-cell history and found:

- exactly one target campaign/Quest 2 submission record, not duplicates;
- the record had been updated to the supplied replacement `nevent`;
- the replacement event was created after the issue was opened;
- the resubmission transaction and chain pointer update had succeeded.

This rejected the hypotheses that the chain still pointed to the old event, the
resubmit never reached chain, or `.find()` selected a duplicate stale record.

The previous Quest 2 event contained eight subtask slots but only the first answer
was non-empty. The replacement event contained all eight answers. This creates an
important unresolved discrepancy: the reporter remembered all eight answers being
displayed before the failure, but the old persisted event could not account for
that state. A local UI/form state may have been involved.

### Source Diagnosis

The pre-fix source inspection established four interacting faults:

1. Publishing tried relays sequentially and returned after the first accepted
   write, so the event normally had only one demonstrated copy.
2. The encoded `nevent` listed candidate relays rather than only relays that had
   stored and returned the exact event.
3. The participant fetch path did not reliably query the advertised relay set and
   could be ended by an early empty/EOSE result before a slower valid result.
4. Retries reused the same promise instead of starting a fresh relay request, and
   failures collapsed into a generic `Event not found` state.

The high-confidence diagnosis therefore combined write-side false redundancy with
read-side race and poor diagnostics. The reporter's current event was valid and
available; the application failed to retrieve it reliably.

## Human Architecture Decision

The first implementation plan added Netlify Blobs as a server-side recovery copy.
After that implementation existed, the user explicitly changed the architecture:

- Nostr relays are the only persistent store for submission events.
- A browser may keep a validated localStorage cache and relay repair tasks.
- Signed events must not be persisted to Netlify Blobs, a database, or another
  centralized service.
- Repair must not publish to public relays without explicit authorization.
- Issue-specific recovery must become a generic relay backfill tool that republishes
  the exact signed event without resigning or changing the on-chain reference.

This was not implementation churn. It was a product/privacy constraint discovered
through human-in-the-loop review. The final fixture must treat it as a guardrail.

## Regression Review Loop

A side review of the first relay-only implementation identified three genuine
regression risks:

### Read Relays Polluting Write Targets

The Nostr pool retained relays opened while reading advertised `nevent` locations.
Using the pool's active relays as later write targets meant external or malicious
read relays could accumulate and slow every future publication.

Decision: writes use configured relays only; advertised relays are read-only inputs.

### Social Events Inheriting Submission Quorum

The generic publishing path accidentally imposed submission quorum 2 on comments,
likes, and other social events, changing existing availability behavior.

Decision: submission/campaign/achievement data may require quorum 2; generic social
events retain single-verified-copy success unless separately redesigned.

### Duplicate Publish Causing Infinite Repair

Some relays reject an exact repeat as duplicate even when the event already exists.
Skipping read-back after a rejected publish left repair tasks retrying forever.

Decision: perform read-back after every publish outcome; valid retrieval, not ACK
status, determines completion.

The user asked the agent to fix all three. Tests increased from 30 passing cases to
35, then to 39 after the diagnostics work.

## Diagnostic Follow-Up

During local verification, a separate campaign-content warning initially looked
similar to issue #54. The agent used page state and read-only relay probes to show
that the repaired submission event was then readable on all four configured
relays, while the warning concerned historical campaign cover events.

That follow-up exposed another classification defect: an unavailable relay could
be flattened into an empty result and mislabeled `event_absent`. The final change:

- counts only explicit EOSE as `missing`;
- records timeout, closed, and failed separately;
- emits safe event ID and relay attempt metadata without content or signatures;
- reports `event_absent` only when every relevant relay confirms missing.

This became commit `a2f9885`.

## Confirmed, Rejected, And Open Conclusions

### Confirmed

- The replacement event was valid and contained all eight responses.
- The chain pointed to that replacement event and had no duplicate target record.
- Pre-fix publication did not establish the relay redundancy advertised by the
  `nevent`.
- Pre-fix retrieval could lose to a fast empty relay and did not perform a true new
  request on retry.
- The first repair introduced three real cross-feature regressions, later fixed.
- The final architecture intentionally excludes centralized persistent backup.

### Rejected

- The replacement event itself was corrupted.
- The chain still pointed to the old event.
- Resubmit failed to update chain.
- Duplicate submission records caused stale selection.
- A publish ACK alone proves a durable copy.

### Still Open

- Why the reporter previously saw eight answers when the old persisted event had
  only one non-empty answer.
- Whether the reporter completed final UAT after deployment.
- The exact browser/network condition that made the participant path fail at the
  reported moment.

## Fixture Use

Blind runs should not receive this digest. Evaluators use it after the run to judge
whether the agent gathered equivalent evidence, revised its hypotheses, respected
human architecture decisions, and caught cross-feature regressions.
