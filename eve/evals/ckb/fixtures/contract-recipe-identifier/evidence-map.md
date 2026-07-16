# Evidence Map: `44b1c88`

## Provenance

- Parent: `9665745d1d39f0aa6395569e5e1b0fe6f3400695`
- Fix: `44b1c88481df2d176c0ee96226996017fcad85f5`
- Fix date: 2025-07-30
- Original Codex conversation: not found in the local session archive
- Evidence mode: repository-history reconstruction

## Evidence Chain

### E1: Canonical Call-Site Identifier

The following surfaces use `CKBoostProtocol.update_protocol`:

- `contracts/contracts/ckboost-protocol-type/src/fallback.rs`
- `contracts/contracts/ckboost-protocol-type/src/main.rs`
- `contracts/contracts/ckboost-protocol-type/src/modules.rs`
- `contracts/tests/src/protocol_type_tests.rs`
- `contracts/tests/src/transaction_context_integration_tests.rs`

This establishes the canonical identifier from multiple independent callers and
test builders.

### E2: Mismatching Rule Identifier

At the parent revision, only this constructor used the short path:

```text
TransactionValidationRules::new(b"update_protocol")
```

The rule lives in `recipes.rs`, while the transaction recipe carries the qualified
path from E1.

### E3: Exact Framework Comparison

`ckb_deterministic/src/validation.rs` compares:

```text
context.recipe.method_path_bytes() != self.method_path
```

and returns `WrongMethodPath` before the remaining validation rules execute.

This makes the diagnosis mechanistic rather than a naming-style preference.

### E4: Historical Diff

`44b1c88` changes exactly:

```text
update_protocol
-> CKBoostProtocol.update_protocol
```

No other file changes. This is strong repair evidence, but it does not itself prove
the original runtime trace.

### E5: Test Context

The repository contains protocol and transaction-context tests using the qualified
path. Several integration tests were ignored because the test framework required a
TransactionRecipe witness in the last position. That limitation must remain a
separate verification note, not be misdiagnosed as the method-path bug.

## Causal Classification

- `known_from_history`: E1, E2, E4.
- `framework_semantics`: E3.
- `verification_context`: E5.
- `not_recovered`: original user report, runtime error log, and repair conversation.

## What A Good Agent Should Do

1. Search all method-path producers and consumers.
2. Identify the canonical path from the public entrypoint and witness builders.
3. Inspect the validator's comparison semantics.
4. Compare the rule constructor byte-for-byte with the canonical path.
5. Propose the smallest correction.
6. Avoid changing public method names or unrelated contract logic.

## What It Should Not Claim

- That it observed the original chain failure directly.
- That all integration tests passed historically.
- That the contract's business rules were wrong.
- That a deployment or broadcast was performed.
