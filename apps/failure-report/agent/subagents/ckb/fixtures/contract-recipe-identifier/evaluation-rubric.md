# Evaluation Rubric: `44b1c88`

## Evaluation Target

This is a narrow exact-root-cause fixture. The evaluator tests whether an agent can
trace a smart-contract failure across public method dispatch, transaction recipe
construction, framework validation, and tests, then choose a minimal correction.

Historical commit matching is relevant here, unlike issue #54. The evaluator still
accepts an equivalent one-line implementation if it preserves the canonical path
and all surrounding behavior.

## Scoring: 100 Points

### Failure Framing: 15 points

- 5: identifies method-path agreement as the relevant contract boundary.
- 4: identifies the protocol type-script validation layer.
- 3: distinguishes validation dispatch from business-rule failure.
- 3: records the lack of original runtime/UAT evidence.

### Source Correlation: 30 points

- 8: searches dispatch, SSRI, fallback, module, witness, and test call sites.
- 8: finds the short rule identifier in `recipes.rs`.
- 8: confirms the validator performs exact byte comparison and returns
  `WrongMethodPath` first.
- 6: identifies the canonical qualified path from multiple independent callers.

### Root Cause: 25 points

- 15: states that `update_protocol` mismatches
  `CKBoostProtocol.update_protocol`.
- 5: explains why deeper cell/business checks are not reached.
- 5: rejects malformed witness, wrong contract rule, and public-method rename as
  primary causes.

### Remediation: 15 points

- 10: proposes the smallest correction that aligns the rule identifier.
- 5: preserves public method names, witness encoding, data schema, and unrelated
  validation behavior.

### Verification: 15 points

- 5: validates a valid creation/update path without `WrongMethodPath`.
- 4: preserves invalid lock/type-script rejection behavior.
- 3: checks canonical path consistency across source and tests.
- 3: reports ignored-test or witness-position limitations separately.

## Hard Fail Conditions

- Renames the public method or all callers to the short path without proving that
  the qualified path is not canonical.
- Rewrites protocol business rules instead of fixing the identifier mismatch.
- Claims a runtime or deployment result that is not present in the evidence.
- Treats ignored test limitations as proof that the method-path diagnosis is wrong.
- Broadcasts, deploys, or mutates chain state during diagnosis.

## Expected Gold Conclusion

`TransactionValidationRules` stores `update_protocol`, while the recipe witness and
all canonical protocol callers use `CKBoostProtocol.update_protocol`. The framework
compares these bytes exactly and returns `WrongMethodPath` before deeper validation.
The minimal repair is to align the rule constructor with the qualified path; no
public API or transaction-format change is required.

## Exact-Diff Policy

Mode: `scored`.

The historical one-line change is the preferred implementation shape. Equivalent
code is accepted if it makes the rule path derive from the same canonical constant
and preserves the observable behavior.
