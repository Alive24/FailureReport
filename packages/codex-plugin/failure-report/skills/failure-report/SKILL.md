---
name: failure-report
description: Create, resume, inspect, and hand off a durable FailureReport through the configured public Root MCP tool.
---

# FailureReport Root

Use the configured `failure_report` MCP tool for an incomplete software failure that needs a durable investigation and handoff. The tool accepts the public Root request contract only; never attempt to invoke domain subagents directly.

For a new report, send `operation: "start"` with a unique `request_id`, the available report context, and a concise message. For a later turn, send `operation: "resume"` or `"inspect"` with the Issue-backed report context.

Treat the target repository GitHub Issue as the shared source of truth. Its body is human-readable narrative and its uniquely marked workpad comment carries the structured FailureReport snapshot. Preserve evidence provenance, distinguish fact from inference, and rely on the reachable deployment's network and credential boundary rather than inventing a Root-level approval step.

When Root returns a Todo-ready handoff, use its scope, guardrails, and verification requirements rather than recreating an ungrounded implementation request.
