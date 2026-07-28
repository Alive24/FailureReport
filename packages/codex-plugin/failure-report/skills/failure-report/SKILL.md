---
name: failure-report
description: Create, resume, inspect, and hand off a durable FailureReport through the configured public Root MCP tool.
---

# FailureReport Root

Use the configured `failure_report` MCP tool for an incomplete software failure that needs a durable investigation and handoff. The tool accepts the public Root request contract only; never attempt to invoke domain subagents directly.

For a new report, send `operation: "start"` with a unique `request_id`, the available report context, and a concise message. To begin or retry intake for an existing GitHub Issue before a workpad exists, send only `issue_selector: { repository, issue_number }`; do not invent an Issue URL, workpad marker, comment reference, or revision. Root rehydrates and returns the canonical `issue` context. For a later turn, send `operation: "resume"` or `"inspect"` with that Issue-backed report context.

Treat the target repository GitHub Issue as the shared source of truth. Its body is human-readable narrative and its uniquely marked workpad comment carries the structured FailureReport snapshot. Preserve evidence provenance, distinguish fact from inference, and rely on the reachable deployment's network and credential boundary rather than inventing a Root-level approval step.

Read the latest authoritative workpad revision as a standalone current-state view before using its folded canonical context. Active, Need Human Input, and Completed revisions intentionally render different sections, but all are deterministic projections of the canonical report. For example, a Need Human Input revision exposes confirmed facts, exhausted experiments, eliminated hypotheses, the complete material unknown and question, every viable option, and the same-session resume condition without requiring the canonical JSON to be expanded. If an ordinary section reports omitted items, use the folded canonical context for those items; do not treat omission from the human view as absence. For a multi-comment revision, trust only the final authoritative manifest and its verified ordered chunk references, never a provisional chunk by itself.

For `render_handoff`, send the latest persisted report binding. Root rejects stale revisions and returns exactly one versioned output: a finalized `implementation_handoff`, or a `human_input_request` that keeps the same diagnosis active. Do not treat a diagnostic snapshot as an implementation branch or PR source, and do not infer that rendering changed a tracker or started a coding workflow.

Use `deliver_handoff` only when the caller wants the configured delivery side effect. It takes the same persisted report binding; no request may select a template, Project, field, or state. A configured Root creates a new human-readable Issue comment with folded canonical JSON, then moves the tracker only to its configured `Backlog` or `Todo` destination. `Todo` means Shea Symphony or another downstream implementation system may claim the Issue; it does not mean FailureReport completed implementation or review.

When Root returns an implementation handoff, use its scope, guardrails, outcomes, verification, UAT, immutable references, and residual risks rather than recreating an ungrounded implementation request. When it returns a human-input request, answer its one precise question so Root can resume the same durable workpad and diagnostic session.
