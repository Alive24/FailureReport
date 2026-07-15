# Architecture Overview

## Single Public Entry

Eve Root is the only public agent. MCP, Temporal, and Codex integrations invoke
Root through RootInvoker. Root decides whether to call the internal CKB subagent.

## Shared Context

Once the target repository is known, Root creates or adopts one GitHub Issue in
that repository. Root preserves existing human text and upserts a marked,
stable FailureReport narrative block in the Issue body. One comment marked with
`failure-report-workpad` holds the full structured FailureReport snapshot.

The snapshot's `status` is the MVP lifecycle state. A host may project it to
Project V2 or labels, but that projection is not the source of truth and is not
implemented by the core adapter packages.

Root reloads the workpad before resume and compares revision plus Issue update time
before writing. The GitHub API does not offer this adapter a general transaction;
the publisher re-reads immediately before mutation and rejects a changed revision
or timestamp. Large or sensitive evidence remains an artifact reference.

## Root Host

`EveHttpRootInvoker` is the official composition boundary. It uses `eve/client`
to call Eve's default `/eve/v1` HTTP channel and requests `RootResult` as the
turn output schema. An optional session store reuses Eve session state by Issue
or report identity, but the GitHub workpad remains authoritative.

The app's `mcp` command composes that invoker with the standalone MCP adapter.
The MCP package itself remains transport-neutral and therefore does not depend on
the Eve application.

## Eve and Codex

Eve runs Root sessions, skills, tools, approvals, and declared subagents. Codex
App-server is a Root-owned deep-work tool over JSON-RPC. It receives a bounded
prompt and workpad context, then returns safe structured findings and its thread
reference to Root.

The first app-server client supports the stable stdio sequence:

```text
initialize -> initialized -> thread/start or thread/resume
  -> turn/start -> notifications -> turn/completed
```

## Eve Discovery Notes

`agent/config/` and `agent/subagents/ckb/fixtures/` are intentional extension
directories, not Eve authored slots. Eve reports them as ignored during discovery;
the application explicitly imports backend policy JSON, and fixtures are loaded
by tests and evals. This keeps configuration and domain evaluation material
isolated without replacing Eve's standard instructions, skills, tools, or
subagent layout.
