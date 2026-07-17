# Provider Boundary

> **Status: implemented MVP architecture.** FailureReport has three separate
> layers: an Eve extension supplies domain capability, Root owns the diagnostic
> workspace/session, and the one Codex worker diagnoses inside that workspace.

## Decision

Eve Root is the only public supervisor. The CKB package is an internal reusable
extension, and `agent/subagents/codex/` is the only declared worker. Outer MCP,
Temporal, and Codex-plugin packages call Eve's default Channel; they never call a
domain extension or a worker directly.

```text
MCP / Temporal / Codex plugin
            |
     outer ecosystem wrapper
            |
  Eve default HTTP Channel
            |
       Eve Root Supervisor
       /                 \
CKB Eve extension   prepare_diagnostic_session
 domain capability          |
                    Root-owned worktree + workpad session
                               |
                    one Codex App Server worker
                               |
             persistent Codex thread in diagnostic worktree
```

Only Root is public, through `eve/agent/channels/eve.ts`. An extension namespace,
domain id, worker name, provider id, Git worktree path, or native-skill source is
never an MCP or Temporal API field.

## Responsibility Split

| Layer              | Owns                                                                                                                             | Does not own                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| CKB extension      | CKB instructions, `failure-report-ckb-debugging`, deterministic `ckb__recommend_log`                                             | sandbox, worktree, provider config, session preparation, subagent                             |
| FailureReport Root | profile registry, approval, source-checkout verification, worktree/branch allocation, workpad/session/thread journal, delegation | CKB skill content, third-party Codex provider implementation                                  |
| Codex worker       | shell/Git/MCP diagnosis in Root-provided `cwd`, tests and diagnostic artifacts                                                   | selecting `cwd`, checkout, branch, skill path, GitHub workpad writes, code changes by default |

This respects [Eve extension boundaries](https://eve.dev/docs/extensions): extensions
contribute capabilities but cannot define an agent, sandbox, schedule, or nested
subagent.

## Root-Owned Diagnostic Session

Root's always-approved `prepare_diagnostic_session` tool accepts only:

- report id and GitHub Issue identity;
- a fixed `domain_id`; and
- a bounded diagnostic request.

It never accepts model-provided `cwd`, branch, backend, or skill path. The fixed
domain-profile registry resolves the installed CKB package's native skill source,
then Root creates or restores one deterministic diagnostic worktree. Before Codex
runs, Root writes the durable state to the Issue workpad and materializes:

```text
<diagnostic-worktree>/.agents/skills/failure-report-ckb-debugging
  -> <installed-ckb-extension>/extension/skills/failure-report-ckb-debugging
```

The link is created only when missing. A normal file, an unexpected/broken link, a
source without `SKILL.md`, or any path escaping the assigned worktree/package fails
closed with `needs_input`; Root never overwrites target-repository content.

The report directly uses `diagnostic_session`, with no `execution_state` migration:

```ts
type DiagnosticSession = {
  domain_id: string;
  backend_id: "codex_app_server";
  codex_thread_id?: string;
  worktree: {
    identity: string;
    path: string;
    branch: string;
    base_revision: string;
    head_revision: string;
  };
  last_diagnosed_at?: string;
};
```

`target.source_checkout_path` identifies the Root-provided source checkout. It does
not mean FailureReport created that checkout. Root validates canonical checkout,
origin, deterministic worktree path, branch, base revision, and HEAD before resume.
External HEAD mutation becomes `needs_input`, never an implicit fallback to the
source checkout. Branches use `failure-report/diagnostic/<domain>/...`.

GitHub's Issue body and marked workpad remain shared collaboration context; the
workpad additionally persists diagnostic session state. The worker never gains
GitHub write capability.

## Codex Native Skill and Worker

The prepared delegation begins with exactly `$failure-report-ckb-debugging` before
the revision-bound diagnostic-session envelope. Codex's native skill discovery finds
the worktree-local `.agents/skills` symlink, so the worker uses native `$skill`,
shell, Git, and MCP rather than Eve's `load_skill` tool or a copied global skill.

The Codex App Server model is launched only after Root validates the envelope and
workpad. It receives:

```text
cwd: Root-owned diagnostic worktree
threadMode: persistent
approvalMode: on-request
sandboxMode: workspace-write
```

`workspace-write` permits focused tests, caches, and debugging artifacts. It does
not authorize a diagnostic worker to modify business code, commit, or turn the task
into implementation unless Root explicitly grants that authority. After every turn,
Root records the current HEAD, timestamp, and provider thread id so the same Codex
thread can resume later.

## Verification Scope

Tests cover direct protocol renames and legacy-field rejection; allocation and
resume; external-HEAD rejection; workpad/thread persistence; native-skill link
creation, repair, and fail-closed conflicts; and the CKB extension's pure-capability
shape. An optional local App Server smoke test can query `skills/list` in a temporary
Git worktree without starting a model turn.

## References

- [Eve extensions](https://eve.dev/docs/extensions)
- [Codex App Server native skills](https://learn.chatgpt.com/docs/app-server#skills)
