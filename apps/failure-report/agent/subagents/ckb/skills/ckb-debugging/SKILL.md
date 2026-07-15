---
name: ckb-debugging
description: Investigate CKB smart-contract and transaction failures using explicit evidence, debugger scripts, and narrowly scoped diagnostic recommendations.
---

# CKB Debugging Practice

Locate the first failing boundary before proposing a fix. Prefer a reproducible
debugger-script invocation or focused unit test. Preserve transaction inputs,
network context, script hashes, and error output as artifacts. Recommend added logs
only when they distinguish plausible hypotheses, and state their expected signal.
