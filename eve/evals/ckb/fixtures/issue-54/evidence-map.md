# Evidence Map: CKBoost Issue #54

## Purpose

This map separates evidence available in the original report, evidence gathered by the diagnosis conversation, human decisions, and evidence learned during implementation. It prevents an evaluator from rewarding hindsight as though it were known at intake.

## Timeline

| Time | Event | Evidentiary meaning |
| --- | --- | --- |
| 2026-07-09 22:35 UTC | Issue #54 opened | Establishes symptom, environment, reproduction, impact, hypotheses, desired invariants, and acceptance criteria |
| 2026-07-10 10:23 UTC | Reporter provides affected `nevent` in a comment | Supplies a concrete private-to-workflow artifact; it should be referenced rather than copied into derived fixtures |
| 2026-07-10 12:04-12:13 UTC | Codex runs bounded diagnosis | Per-relay probes, chain history, and source inspection confirm write redundancy and read-race faults while rejecting stale-chain and corrupt-event hypotheses |
| 2026-07-10 12:20 UTC | Initial plan proposed | Establishes quorum/read-back design but still includes centralized Blob recovery |
| 2026-07-10 17:45 UTC | User revises architecture | Makes relays the only persistent store and replaces Blobs with validated local cache plus repair queue |
| 2026-07-10 18:38 UTC | `28fa51f` committed | Implements initial cross-module reliability and recovery response |
| 2026-07-10 19:13-19:25 UTC | Side review and correction loop | Finds write-target pollution, accidental social quorum change, and duplicate-publish repair loop; user requests fixes |
| 2026-07-10 19:41 UTC | `fe8d8bd` committed | Adds defenses and tests against newly identified regression paths |
| 2026-07-10 19:58 UTC | `a2f9885` committed | Improves fetch classification and diagnostic fidelity |
| 2026-07-10 20:05 UTC | Maintainer comments that it should be fixed | Confirms repair intent, not reporter UAT or issue closure |
| 2026-07-11 | Fixture reconstructed | Issue remains open; final affected-user recovery is not evidenced |

## Original Report Evidence

### E1: Prior Successful Read

- Source: issue Summary and Preconditions.
- Fact: all eight responses initially displayed after submission.
- Supports: the application once had a usable content path or recoverable state.
- Does not prove: which relay retained the event or when availability was lost.

### E2: Durable Reference Without Readable Content

- Source: Actual Behavior and storage debug panel.
- Fact: on-chain submission state existed while content retrieval failed.
- Supports: cross-store inconsistency or partial success at the product level.
- Does not prove: that the event was globally absent from Nostr.

### E3: Persistent Recovery Failure

- Source: Reproducibility and Steps to Reproduce.
- Fact: refresh, reopen, wait, retry, and `Resubmit Content` did not durably restore the submission.
- Supports: the recovery path did not enforce or demonstrate durable readability.
- Does not prove: whether each attempt produced a new event or transaction.

### E4: User And Business Impact

- Source: Impact.
- Fact: an active hackathon submission could not be reviewed or edited before its deadline.
- Supports: high severity and the need for an immediate recovery path.

### E5: Candidate Causes

- Source: Possible Technical Cause.
- Classification: reporter hypotheses, not observed facts.
- Evaluator rule: an agent may preserve and rank them but may not promote one to confirmed root cause without tool evidence.

### E6: Desired System Contract

- Source: Suggested Fix and Acceptance Criteria.
- Fact: the report explicitly asks for multi-relay publication, independent retrieval verification, delayed reference update, old-reference preservation, diagnostics, and recovery.
- Supports: a broad implementation can remain faithful to a compact handoff.

## Diagnosis Conversation Evidence

### D1: Replacement Event Validity And Availability

- Source: independent per-relay probes in the original Codex session.
- Fact: the replacement event contained all eight responses, was 13,451 bytes, used kind 30078, and passed event identity validation.
- Fact: valid copies were returned by slower relays while one faster relay returned empty and another failed to connect.
- Supports: the replacement event was not globally lost or corrupt; retrieval was path- and timing-dependent.

### D2: Read-Side Race

- Source: relay timing plus pre-fix fetch source.
- Fact: an empty relay responded before relays containing the valid event.
- Fact: the fetch path could stop after an early EOSE/empty result, and retries reused the same promise.
- Supports: a fast empty relay could produce a false missing result.

### D3: Chain And Record History

- Source: CKB user-cell history inspected during diagnosis.
- Fact: one matching campaign/quest record existed and had updated to the supplied replacement `nevent`; resubmission reached chain.
- Supports: stale chain pointer, failed on-chain update, and duplicate-record selection were rejected.

### D4: Write-Side False Redundancy

- Source: pre-fix `use-nostr-storage` source and per-relay results.
- Fact: publication returned after the first accepted relay.
- Fact: the `nevent` encoded candidate relays that had not all demonstrated a readable copy.
- Supports: advertised redundancy exceeded verified redundancy.

### D5: Historical Content Discrepancy

- Source: old and replacement event inspection.
- Fact: the old event had eight subtask slots but only one non-empty answer; the replacement event had all eight.
- Supports: the old event cannot explain the reporter's remembered eight-answer UI.
- Remains open: whether local form state or another artifact supplied the earlier display.

### D6: Human Architecture Constraint

- Source: explicit user correction during implementation.
- Decision: Nostr relays remain the only persistent store; local validated cache and repair tasks are permitted; centralized persistent backup is prohibited.
- Supports: removing the initially implemented Netlify Blob path was a required product/privacy decision, not an implementation regression.

### D7: Independent Regression Review

- Source: sidechat review pasted into and verified by the implementation session.
- Confirmed findings:
  - read-opened relay state polluted future write targets;
  - comments and likes accidentally inherited submission quorum 2;
  - duplicate/rejected publish skipped read-back and could retry forever.
- Supports: a complete loop must evaluate cross-feature behavior after the primary repair, not stop when initial tests pass.

Full redacted context: [`conversation-evidence.md`](conversation-evidence.md).

## Repair Evidence

### R1: Initial Reliability Hardening

- Commit: `28fa51fb1f9885ac4adef00b51e9fa5a3923c00d`
- Scale: 27 files, 2,628 insertions, 1,213 deletions.
- Directly mapped outcomes:
  - explicit relay core and read-after-write verification;
  - required verified-copy quorum;
  - local validated event cache;
  - relay repair queue;
  - browser fetch abstraction;
  - backfill tooling and tests;
  - Nostr canary;
  - UI relay attempt and verification state;
  - prevention of chain finalization after storage quorum failure.
- Interpretation: the report exposed a missing reliability boundary, not merely one bad conditional.

### R2: Regression Prevention

- Commit: `fe8d8bda0d12ac810d8a750e13ef922186f812d4`
- Scale: 16 files, 761 insertions, 148 deletions.
- Newly hardened behaviors:
  - configured write relays remain separate from relays opened during reads;
  - browser publishing receives dedicated tests;
  - submission records match and update the intended campaign and quest;
  - duplicate records are removed defensively;
  - repair and backfill edge cases gain coverage.
- Interpretation: these are investigation-derived safeguards consistent with the report's invariants, even where the issue did not prescribe their exact shape.

### R3: Diagnostic Fidelity

- Commit: `a2f98850862a8bc9ef9bb08c364ef6e8f03461a0`
- Scale: 5 files, 274 insertions, 49 deletions.
- Newly distinguished states:
  - `event_absent`: all queried relays explicitly confirm missing;
  - `relay_unavailable`: absence cannot be established because a relay timed out or otherwise failed;
  - `invalid_event`: a relay returned content that fails event validation.
- Interpretation: this directly improves future Failure Reports by preventing an infrastructure failure from being mislabeled as content absence.

## Verification Evidence

The historical tests cover the following observable contracts:

| Contract | Representative test evidence |
| --- | --- |
| Only validated copies count toward quorum | `relay-core.test.ts`: publishes to every relay and reports readable copies only |
| Chain update cannot follow failed storage | `relay-core.test.ts`: rejects storage before chain submission when quorum is not met |
| ACK is not the source of truth | duplicate publish rejection followed by valid read-back counts as success |
| Slow valid results are not hidden by fast empty relays | fast-empty versus slower-valid relay test |
| Missing differs from unavailable | EOSE is missing; aborted request is timeout; browser fetch returns structured codes |
| Returned data must be authentic and applicable | invalid ID/signature and missing CKBoost tags are rejected |
| Cache is evidence, not blind trust | valid cache hit and tampered entry eviction tests |
| Repair completion requires verification | repair queue removes a relay only after successful read-back |
| Backfill preserves event identity | exact signed event is republished; tampered recovery event is rejected |
| Write policy is explicit | browser publisher never promotes read-opened relays into write targets |
| Submission replacement is scoped | campaign/quest matching and duplicate-removal tests |

## Evidence Gaps

The following must not be marked verified from repository and conversation history alone:

- successful load, edit, and reload by the reporter after deployment;
- accessibility after a new browser session;
- confirmation that the raw event ID no longer appears in the wrong UI field;
- production relay behavior under the user's original conditions;
- issue closure or reporter acceptance.

These gaps require UAT or operational evidence. Automated tests demonstrate the new invariants but do not retroactively prove recovery of the original content.

## Causal Classification

Use these labels when evaluating an agent-generated report:

- `known_at_intake`: E1 through E6.
- `diagnosis_evidence`: D1 through D5.
- `human_decision`: D6.
- `review_discovery`: D7.
- `confirmed_diagnosis`: single demonstrated write copy plus misleading relay hints, early empty-result race, ineffective retry, and weak error classification.
- `implementation_discovery`: concrete write-set contamination, record matching, retry, cache, and diagnostic edge cases found while repairing.
- `historical_validation`: R1 through R3 and their tests.
- `still_unverified`: affected-user UAT and production recovery.
