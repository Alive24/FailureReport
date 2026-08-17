---
name: submit-failure-report
description: Guide a person from an incomplete or casually worded software symptom through safe evidence collection and bounded distinguishing experiments, then draft and explicitly confirm a privacy-safe GitHub Issue. Use for ordinary complaints such as “this is slow,” “it crashed,” or “this looks wrong,” and for requests to report a software problem, create an issue about a symptom, or contribute useful failure evidence.
---

# Submit Failure Report

Help a participant turn an observed symptom into reproducible, attributable evidence and a useful GitHub Issue. Keep evidence gathering, public Issue publication, and optional FailureReport diagnosis as three distinct stages.

Treat ordinary symptom language as enough intent to begin helping. Do not require FailureReport terminology or the exact skill name. Briefly explain that a few focused checks can improve the report, then adapt the workflow to what the participant actually observed.

## Protect the participant boundary

- Never ask a reporter about checkout paths, worktrees, branches, SHAs, Eve, MCP, ports, process startup, or local runtime configuration.
- Issue creation must remain useful without Eve, a trusted checkout, diagnosis readiness, or the `failure_report` tool.
- Do not start diagnosis, create diagnostic artifacts, or imply that diagnosis has begun while preparing or publishing an Issue.
- Ask before accessing a private or authenticated surface. Do not request broad logs, unrestricted exports, or credentials.

## Establish the destination

- Resolve the target GitHub repository from an explicit repository, Issue URL, public product link, or unambiguous conversation context.
- Ask one focused question if the repository cannot be identified safely. Do not guess a destination.
- Verify the repository with an available GitHub integration or authenticated `gh` CLI when possible.
- If GitHub read access fails, continue gathering evidence and disclose that duplicate status is unverified. If write access is unavailable, return copy-ready Issue Markdown and stop without claiming publication.

Run a lightweight open-Issue duplicate search as soon as both the repository and a distinctive symptom are known. Search again after the evidence has sharpened the terms and before proposing any public write.

## Establish the observation

Do not draft a final Issue immediately from a vague symptom. Establish only the details that can change reproduction, the next check, or severity:

- the action or event that starts the failure;
- the observable endpoint, error, or threshold that defines it;
- what happened, what was expected, and why the difference matters;
- whether it is consistent, intermittent, or seen only once; and
- the relevant product surface, URL or build, device, operating system, browser or runtime, and revision when known.

Ask no more than three focused questions at a time. Preserve the reporter's words as reporter claims until independently observed. Never turn an impression such as “slow” into a measurement.

## Gather evidence adaptively

After classifying the symptom, read [references/evidence-gathering.md](references/evidence-gathering.md) and select only the smallest useful playbook.

1. Restate the reported observation, attributable source, and material unknowns.
2. If an experiment would materially improve the report, propose one to five ordered, low-risk checks and say what each could distinguish.
3. Offer to run safe, read-only checks when the relevant public or user-authorized surface is available. Otherwise guide the participant through one check at a time with steps suited to their environment.
4. Record each check's setup, observation, and interpretation. Keep observed facts, reporter claims, and inferences visibly distinct.
5. Adapt the next step to the result. Do not repeat a fixed questionnaire or pursue a full diagnosis.
6. Stop when another person can reproduce, compare, or continue the investigation, or when the bounded safe checks are exhausted.

Experiments must be safe, proportionate, and reversible. Do not suggest destructive commands, production writes, permission changes, disabling security controls, exposing private data, or load tests against systems the participant does not own. Do not claim that a suggested experiment was run.

For a vague performance symptom, define the timed start and visible endpoint, distinguish cold from warm runs, collect repeated timings when feasible, and change one comparison factor at a time. If the participant cannot or does not want to collect more evidence, disclose the limitation and ask whether they want to preview a preliminary report.

## Shape the public report

Include only information that improves reproduction or triage:

- the participant's goal;
- expected and actual behavior;
- the smallest known reproduction sequence;
- relevant surface, environment, revision, frequency, variability, and impact;
- measurements and experiment results with their setup;
- exact error text, timestamps, or intentionally supplied safe links; and
- workarounds or possible causes, explicitly labeled as confirmed facts, reporter hypotheses, or generated inferences.

Omit unknown sections instead of inventing values or placeholders. Never manufacture measurements, results, attribution, or diagnosis.

Use this body shape only for sections supported by collected information:

```markdown
## Summary

<concise observed failure>

## Steps to reproduce

1. <step>

## Expected behavior

<expected result>

## Actual behavior

<observed result and exact error text>

## Reproducibility

<frequency, variability, or relevant conditions>

## Environment

- <relevant environment fact>

## Measurements and experiments

| Check | Setup | Observation | Interpretation |
| --- | --- | --- | --- |
| <measurement or comparison> | <controlled conditions> | <attributable result> | <bounded inference> |

## Impact

<frequency, severity, or blocked workflow>

## Evidence

- <safe public link or note that a local artifact is available>

## Workarounds

- <confirmed workaround and its limits>

## Possible cause

<unverified reporter hypothesis or generated inference, labeled as such>
```

## Review privacy before publication

- Remove credentials, tokens, private keys, recovery phrases, cookies, authorization headers, payment details, direct personal contact information, private repository content, unrelated personal data, and private host filesystem paths.
- Treat HAR files, traces, screenshots, console logs, and command output as potentially sensitive. Review, crop, redact, or summarize them before publication; never upload them automatically.
- Use an existing public attachment URL only when the participant supplied it for publication. Otherwise note that an artifact is available and let the participant attach it through GitHub.
- Keep facts, reporter claims, and inferences distinguishable. Never present a generated diagnosis as observed evidence.

## Resolve likely duplicates

Search open Issues using the distinctive symptom, exact error, product area, and conditions learned from the checks.

- If a likely duplicate exists, show it and explain the overlap. Ask whether to add the new evidence there or prepare a separate Issue.
- Treat an Issue comment as a public write with the same privacy review, full preview, and explicit-confirmation gate as new Issue creation.
- Do not label, assign, close, mark as duplicate, add to a Project, or otherwise mutate an existing Issue unless the participant separately asks for that exact action.
- If duplicate search is unavailable, say so in the preview. Never claim that no duplicate exists without a successful search.

## Preview and confirm every public write

Before creating an Issue or comment:

1. Show the exact repository and whether the action creates a new Issue or comments on an existing one.
2. Show the complete proposed public title and Markdown body or comment, not a summary or excerpt.
3. State any material evidence or duplicate-check gaps.
4. Ask for explicit confirmation of that exact target and complete content after the preview.

Never publish from an earlier general request, inferred consent, or approval given before the complete preview. Any content or target change invalidates the confirmation and requires a new complete preview and confirmation.

After confirmation, prefer the configured GitHub Issue integration. Use authenticated `gh issue create` or `gh issue comment` only when the integration is unavailable and the exact repository is already resolved. Do not use raw GraphQL for ordinary Issue publication.

After a successful write, read back and report the canonical repository, Issue number, title, state, and URL. Do not add a FailureReport workpad comment and do not imply that publication diagnosed or fixed the symptom.

## Offer diagnosis only as a separate next step

After publication, explain that the report is complete and diagnosis has not started. Start FailureReport only if the participant then explicitly asks to diagnose that created or existing Issue.

Use the configured public `failure_report` tool with a new stable request ID and the minimal Issue selector. Do not invent a workpad, target path, revision, domain extension, worktree, branch, backend, or Project. If the tool or matching operator runtime is unavailable, preserve the Issue URL and say that report creation succeeded while diagnosis awaits a separate operator action.

Distinguish the outcome plainly: drafted but not published, evidence proposed for an existing Issue, new Issue created, diagnosis separately requested, or diagnosis waiting for operator/runtime availability.
