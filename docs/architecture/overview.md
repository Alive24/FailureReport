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

## GitHub Gateway

GitHub is a Root-owned internal integration, never a public CKB, MCP, or Temporal
API. Root tools use the narrow `GithubIssueGateway` port. The default factory
creates an `OctokitIssueGateway`, so Issue metadata/body reads, comment
pagination, narrative updates, and workpad comment writes all use GitHub's
official TypeScript SDK.

By default, the factory obtains the active `gh auth login` token once per Root
process with `gh auth token`, keeps it in memory, and supplies it to Octokit.
It does not use `gh api` for normal Issue I/O. This keeps existing local GitHub
CLI login convenient without requiring users to install a GitHub App. A direct
`GithubCliIssueGateway` remains available only when
`FAILURE_REPORT_GITHUB_GATEWAY=gh-cli` explicitly selects the legacy local
fallback or fixture-capture path.

Token and GitHub App installation modes are injected through runtime environment
configuration. GitHub App credentials are optional, and are the preferred model
for a centrally operated multi-user/self-hosted deployment where a shared
machine-local `gh` login is unsuitable. No credential material is protocol data,
workpad content, prompt context, logs, or fixtures.

Octokit does not create a GitHub-side compare-and-swap primitive. The gateway's
shared publisher retains FailureReport's application-owned write-before-reload
flow: it checks the report's workpad revision, reloads before mutation, compares
the Issue `updated_at` and marked-comment revision again, then rejects stale
writes before creating or updating the one workpad comment.

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
