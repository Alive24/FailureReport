# Gold Failure Report: Protocol Recipe Method Path Mismatch

Fixture ID: `ckboost/commit-44b1c88-recipe-identifier` Schema target: `failure-report/v1` Fixture perspective: reconstructed from repository history before the one-line fix Last reconstructed: 2026-07-11

## Report State

- Status: `todo_ready`
- Domain pack: `ckb`
- Severity: medium, contract-validation blocking
- Confidence in root cause: high
- UAT required: no, provided contract tests and deterministic validation are the required verification surface
- Historical fix: commit `44b1c88481df2d176c0ee96226996017fcad85f5`

No original user-authored issue or Codex repair conversation was found locally for this 2025 commit. This fixture is explicitly marked as repository-history reconstruction, not as a recovered historical transcript.

## Target

- Repository: `Alive24/CKBoost`
- Parent revision: `9665745d1d39f0aa6395569e5e1b0fe6f3400695`
- Component: `contracts/contracts/ckboost-protocol-type/src/recipes.rs`
- Contract: `ckboost-protocol-type`
- Script kind: CKB type script
- Validation framework: `ckb_deterministic::TransactionValidationRules`
- Operation: `CKBoostProtocol.update_protocol`

## Reconstructed Failure

The protocol contract receives a transaction recipe whose method path is the fully qualified identifier `CKBoostProtocol.update_protocol`. The fallback, SSRI entry point, protocol module, and integration-test witnesses all use that identifier.

At the parent revision, the `update_protocol` validation rule was constructed with the shorter byte string `update_protocol`. The validation framework compares the recipe method path and rule method path exactly. It therefore returns `WrongMethodPath` before the intended cell-count, immutability, and business-rule checks can run.

## Expected Behavior

- The rule identifier exactly matches the method path carried by the recipe witness.
- A valid protocol creation or update reaches the intended validation rules.
- Invalid admin-lock, type-script, argument, and protocol-data changes continue to fail for their own reasons.
- The fix remains local to the method-path contract and does not rename the public SSRI method or change transaction data structures.

## Evidence

### Confirmed Facts

- `fallback.rs` dispatches `CKBoostProtocol.update_protocol`.
- `main.rs` exposes `CKBoostProtocol.update_protocol` through SSRI.
- `modules.rs` creates recipe witnesses with `CKBoostProtocol.update_protocol`.
- Integration tests construct the same fully qualified witness path.
- `recipes.rs` alone used `update_protocol` in `TransactionValidationRules::new`.
- `TransactionValidationRules::validate` compares the two byte sequences exactly and returns `WrongMethodPath` on mismatch.
- Commit `44b1c88` changes only that short identifier to the fully qualified one.

### Unknown Or Unverified

- The original failing transaction and exact runtime log are not present in the recovered local history.
- The ignored integration test suite was not a reliable historical execution record; its ignore annotations mention witness-position limitations.
- The fixture does not claim a production deployment or chain-level UAT result.

## Hypotheses

| Hypothesis | Status | Evidence |
| --- | --- | --- |
| The validation rule method path is shorter than the recipe method path | Confirmed | Exact source comparison and one-line historical fix |
| The recipe witness is malformed | Rejected as primary cause | All callers use the expected fully qualified path |
| Contract cell/business rules are the first failing layer | Rejected as primary cause | Method-path comparison occurs before those rules |
| The public method should be renamed to the short path | Rejected | Entrypoints, modules, and tests consistently use the qualified path |

## Diagnosis

This is a contract-internal identifier drift failure. A refactor normalized method names across the contract surface but missed the validation-rule constructor. The agent must recognize that a one-token namespace mismatch can prevent all deeper smart-contract reasoning from executing.

## Todo Handoff

### Goal

Restore exact method-path agreement for protocol update validation without changing the public contract method, transaction recipe format, or unrelated rules.

### Scope In

- Align the validation-rule method path with the canonical qualified method path.
- Run focused protocol integration and validation tests where the framework allows.
- Preserve debug evidence for the observed recipe path and expected rule path.

### Scope Out

- Renaming SSRI methods or changing witness encoding.
- Refactoring protocol business rules.
- Changing cell counts, type IDs, or protocol data schemas.
- Deploying a new contract or broadcasting a transaction as part of diagnosis.

### Verification

- A valid protocol creation/update fixture reaches validation without `WrongMethodPath`.
- Existing invalid-lock and invalid-type-script tests still reject the invalid transactions.
- Source search finds one canonical qualified method path across dispatch, witness construction, modules, and validation rules.
- Any ignored test limitation is reported separately from the method-path result.

The historical repair is intentionally a one-line correction. The fixture should not reward a broad rewrite for this failure class.
