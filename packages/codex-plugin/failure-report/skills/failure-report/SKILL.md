---
name: failure-report
description: Create, resume, inspect, and hand off a durable FailureReport through the configured public Root MCP tool.
---

# FailureReport Root

Use the configured `failure_report` MCP tool for an incomplete software failure that needs a durable investigation and handoff. The tool accepts the public Root request contract only; never attempt to invoke domain subagents directly.

For a new report, send `operation: "start"` with a unique `request_id`, the available report context, and a concise message. To begin or retry intake for an existing GitHub Issue before a workpad exists, send only `issue_selector: { repository, issue_number }`; do not invent an Issue URL, workpad marker, comment reference, or revision. Root rehydrates and returns the canonical `issue` context. For a later turn, send `operation: "resume"` or `"inspect"` with that Issue-backed report context.

Treat the target repository GitHub Issue as the shared source of truth. Its body is human-readable narrative and its uniquely marked workpad comment carries the structured FailureReport snapshot. Preserve evidence provenance, distinguish fact from inference, and rely on the reachable deployment's network and credential boundary rather than inventing a Root-level approval step.

For `render_handoff`, send the latest persisted report binding. Root rejects stale revisions and returns exactly one versioned output: a finalized `implementation_handoff`, or a `human_input_request` that keeps the same diagnosis active. Do not treat a diagnostic snapshot as an implementation branch or PR source, and do not infer that rendering changed a tracker or started a coding workflow.

When Root returns an implementation handoff, use its scope, guardrails, outcomes, verification, UAT, immutable references, and residual risks rather than recreating an ungrounded implementation request. When it returns a human-input request, answer its one precise question so Root can resume the same durable workpad and diagnostic session.
