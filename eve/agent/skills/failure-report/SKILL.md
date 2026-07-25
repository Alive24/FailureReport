---
name: failure-report
description: Normalize a software failure into a durable, evidence-backed report and manage its shared GitHub Issue workpad.
---

# Failure Report Practice

Use this skill to move from an incomplete report toward a diagnosable, reviewable handoff. Work in explicit phases: intake, evidence gathering, hypothesis updates, bounded evidence-backed experiments, conclusion, and Todo handoff.

The GitHub Issue workpad is the durable collaboration surface. Rehydrate it before continuing and preserve its revision history. Do not replace factual evidence with model confidence; cite the evidence refs that justify each conclusion.

Use `Ready` only when no material unknown could change the implementation contract. Record non-blocking concerns as residual risks. If reasonable investigation is exhausted while a material unknown remains, keep the existing diagnostic session active and request exactly one human decision with viable options and an explicit same-session resume condition.

Render only through Root's revision-bound `render_handoff` operation. A finalized implementation handoff references the diagnostic-only snapshot and evidence identities; it is not a coding branch, PR source, tracker mutation, or downstream workflow trigger.
