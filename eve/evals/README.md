# Evaluations

Each domain fixture evaluates the report protocol, evidence traceability, diagnosis, and handoff quality. CKB fixtures live under `evals/ckb/`, alongside the consuming application rather than inside the reusable extension, because they exercise this application's Root-to-worker flow.

Run `pnpm eval` from this app when an Eve model credential and any required protected artifact bindings are available. `ckb/issue-45-sparse` is runnable from public fixture material. Issue #54 remains a full blind-evaluation asset: bind its protected references at the host before running it so gold evidence is not supplied to Root.
