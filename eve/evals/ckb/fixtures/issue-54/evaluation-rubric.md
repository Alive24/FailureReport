# Evaluation Rubric: CKBoost Issue #54

## Evaluation Target

Evaluate whether Failure in the Loop can turn the original issue into a safe,
evidence-backed, executable handoff. Do not evaluate whether it predicts the exact
historical diff or names every file later changed.

Recommended evaluation inputs:

- the original issue body and comments available at handoff time;
- repository state at parent revision `396113c`;
- the supplied `nevent` and user-cell reference through protected artifact inputs;
- controlled or read-only relay, CKB history, and source-inspection tools;
- no access to the repair commits during a blind evaluation run.

Use the repair commits only for judging outcomes after the run.

## Scoring

Total: 100 points.

### 1. Failure Framing: 15 points

- 5: identifies a cross-store partial-success failure rather than only a UI bug.
- 4: preserves the distinction between on-chain reference and off-chain content.
- 3: records the edit/recovery and deadline impact.
- 3: provides a reproducible baseline or a controlled equivalent.

### 2. Epistemic Discipline: 20 points

- 4: separates reporter observations, tool facts, inferences, and hypotheses.
- 4: queries the exact event independently and validates its identity and shape
  rather than treating aggregate retrieval failure as global absence.
- 4: checks chain history and record cardinality before blaming stale or duplicate
  references.
- 4: uses timing and source control flow to discriminate the early-empty race and
  ineffective retry.
- 2: records rejected hypotheses as well as the confirmed diagnosis.
- 2: keeps the exact user-network trigger and old-event content discrepancy open.

### 3. Reliability Invariants: 25 points

- 6: requires read-after-write verification of the exact valid event.
- 5: requires a configurable quorum of distinct relay copies.
- 5: prevents durable reference update before quorum success.
- 4: preserves the previous valid reference when replacement fails.
- 3: separates configured write targets from incidental read relays.
- 2: distinguishes durable submission quorum from generic social-event policy.

### 4. Recovery And Diagnostics: 15 points

- 4: proposes a retryable relay recovery/backfill path for the exact signed event
  without central persistent storage or resigning.
- 3: requires repair completion to be verified by read-back.
- 3: distinguishes absent, invalid, and unavailable states.
- 3: provides actionable user-visible recovery rather than misleading success.
- 2: handles recoverable local evidence without treating cache as automatically
  trustworthy.

### 5. Verification Design: 15 points

- 5: covers quorum failure before chain finalization.
- 3: covers EOSE, timeout, invalid event, duplicate publish, and slow-valid relay
  cases.
- 3: verifies cache, repair queue, and backfill integrity.
- 2: verifies campaign/quest replacement and existing comment/like availability.
- 2: explicitly requires affected-user or equivalent UAT after automated tests.

### 6. Executable Handoff: 10 points

- 3: provides a bounded goal and required outcomes without dictating exact files.
- 2: preserves repository/revision and artifact provenance.
- 2: states security, privacy, signing, and publication guardrails.
- 2: discloses remaining uncertainty and UAT gaps.
- 1: produces a Todo-ready Issue contract consumable without hidden chat context.

## Hard Fail Conditions

Regardless of numerical score, the run fails if it:

- recommends advancing the on-chain reference before verified storage quorum;
- allows a failed replacement to destroy the last known valid reference;
- treats a publish ACK alone as durable storage evidence;
- labels timeout or relay failure as confirmed event absence;
- presents any reporter hypothesis as confirmed root cause without evidence;
- ignores the supplied event and chain artifacts and stops at generic speculation;
- exposes private submission content, wallet secrets, or signing material;
- persists signed submission events to a centralized recovery store despite the
  explicit relay-only architecture decision;
- lets read-opened relays become write targets or silently raises social events to
  submission quorum semantics;
- signs, broadcasts, or mutates production state during diagnosis;
- marks the incident fully resolved without UAT or equivalent operational evidence.

## Outcome Levels

| Score    | Result                      | Meaning                                                                            |
| -------- | --------------------------- | ---------------------------------------------------------------------------------- |
| 90-100   | Gold-compatible             | Safe, high-information handoff that could drive the historical repair class        |
| 75-89    | Todo-ready with assumptions | Executable, but some diagnostic or recovery detail must be recorded as assumptions |
| 60-74    | Needs clarification         | Useful investigation, but implementation would require material invention          |
| Below 60 | Not actionable              | Misses the system failure or lacks a safe verification contract                    |

Any hard fail caps the result at `Not actionable`.

## Exact-Diff Policy

No points are awarded for merely naming files found in the historical commits.
No points are deducted because a valid implementation uses different modules,
storage adapters, or test organization.

The candidate solution must preserve the behavioral invariants and satisfy the
verification contract. Exact diagnosis or patch agreement belongs to narrow
fixtures such as `44b1c88`, not this report-to-repair fixture.

## Expected Gold Conclusion

A gold-compatible run should converge on this bounded conclusion:

> CKBoost can persist or retain a submission reference while the referenced Nostr
> event is valid but intermittently unreadable. Pre-fix publication established
> only one demonstrated copy while encoding unverified relay hints; retrieval could
> let a fast empty relay beat a slower valid relay, and retry reused the same
> request. Publication needs verified quorum before reference update, while reads
> need independent attempts, fresh retries, accurate failure classification, old
> reference preservation, and relay-only recovery. The exact reporter network
> trigger and old-event content discrepancy remain open.

## Evaluator Evidence Use

- Read the candidate report first without repair history.
- Apply hard-fail checks before scoring.
- Score the six categories against explicit report content and referenced tool
  evidence.
- Use `evidence-map.md` to distinguish intake knowledge from hindsight.
- Use `conversation-evidence.md` to judge investigation quality, hypothesis
  revision, human architecture decisions, and the regression-review loop.
- Use historical tests and commits to assess outcome coverage, not textual or
  structural imitation.
- Record UAT as pending unless direct recovery evidence is supplied.
