Generate an English, agent-facing code wiki for FailureReport.

Prioritize:

- a concise quickstart and source map;
- the implemented architecture and runtime workflows;
- the protocol and append-only GitHub workpad lifecycle;
- the domain-extension model;
- generic diagnosis with an empty `domain_extensions` set as a first-class path;
- the diagnostic workspace, session, handoff, and snapshot lifecycles;
- the MCP adapter's private durable operation ledger, single-flight delivery, queueing, reattachment, retention, and migration behavior;
- an operator-oriented existing-Issue walkthrough from Eve startup through reentry, human input, diagnostic finalization, and handoff rendering;
- integration boundaries, operations, testing, and extension guidance.

Treat `README.md`, `docs/architecture/*.md`, `packages/protocol` schemas, Eve agent instructions, and package or skill documentation as authoritative sources. Document current implemented behavior. Clearly distinguish planned, experimental, deprecated, and historical designs. Prefer links to authoritative files over duplicating normative contracts.

Preserve these architecture boundaries:

- Eve Root is the sole supervisor.
- Eve Channels are ingress.
- Optional domain extensions contribute only knowledge, native skills, and deterministic tools; generic diagnosis must not invent a placeholder domain or skill.
- Root owns workpads and host-managed workspaces under `.eve/sandbox-cache`.
- Codex is the diagnostic worker.
- MCP, Temporal, and the Codex plugin remain outer adapters.
- Diagnostic branches are reviewable snapshots, not implementation or pull-request branches.

Exclude secrets, credentials, `.env` files, `.eve` runtime state, `.shea/logs`, `.shea/artifacts`, `.shea/worktrees`, generated build output, caches, temporary diagnostic evidence, and unsupported conclusions inferred only from discussions or stale fixtures.

Ignore untracked or ignored local-only directories that contain no authored source, including `packages/runtime-port/`. Do not give them an architectural role or include them in the source map.

Keep pages practical, precise, navigable, and grounded in current code plus recent Git history.
