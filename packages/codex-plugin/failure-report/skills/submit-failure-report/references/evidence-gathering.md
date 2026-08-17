# Evidence gathering playbooks

Choose only the playbook that matches the observed symptom. Prefer a short sequence of checks that distinguish plausible conditions over a broad questionnaire.

## Performance or slow loading

Define the timer before collecting numbers:

- Start: navigation, click, launch, refresh, or submission.
- End: first meaningful screen, usable controls, completed request, or another visible outcome.
- Context: public URL or build, device, operating system, browser or runtime version, and network type when relevant.

Suggested bounded ladder:

1. Record three cold and three warm runs when feasible. Report the individual values or median and range, not a falsely precise average.
2. Repeat with one controlled change, such as private window/extensions disabled, another browser, another network, cached versus uncached, or local versus deployed.
3. Inspect a browser Network panel or equivalent and record the slowest relevant request, status, and timing without exposing headers, cookies, query secrets, account data, or private URLs.
4. Capture a profiler or performance trace only when practical, authorized, and safe to review before sharing.

Label simulated throttling separately from measured real-device behavior. A synthetic score is not the reporter's observed duration.

## Crash, exception, or failed command

1. Record the exact action and smallest safe input that triggers the failure.
2. Capture exact error text and exit status without credentials or unrestricted logs.
3. Repeat once under the same conditions to establish consistency.
4. Compare one nearby known-good condition, such as a prior version, smaller input, clean test configuration, or alternate supported runtime.
5. Record the first failing version or change only when verified.

## Incorrect result or state

1. Define the input, expected result, and observed result precisely.
2. Reduce the input to the smallest non-sensitive example that still fails.
3. Repeat with one control input that succeeds.
4. Check persistence across refresh, restart, account, or environment only when relevant and authorized.
5. Preserve safe output examples or diffs without inferring the cause from the bad result alone.

## Visual or interaction defect

1. Record viewport or screen size, zoom, display scale, input method, and relevant accessibility settings.
2. Capture the shortest interaction sequence.
3. Compare resize, refresh, keyboard versus pointer, or one alternate browser/device while changing one factor at a time.
4. Prefer a cropped screenshot or short recording that excludes unrelated personal information.
5. Record whether the defect blocks use or is cosmetic.

## Intermittent or environment-specific failure

1. Count successes and failures over a small bounded number of attempts.
2. Record timestamps with timezone only when correlation matters.
3. Change one suspected condition at a time.
4. Note what remains constant between failing and successful attempts.
5. Stop after finding a useful condition boundary or exhausting the agreed attempt budget; preserve uncertainty honestly.

## Evidence record

Record each completed check with explicit provenance:

| Field | Content |
| --- | --- |
| Question | What condition was this check meant to distinguish? |
| Setup | Relevant environment and the one controlled change |
| Observation | Measurement, exact output, or visible behavior and who observed it |
| Interpretation | What it supports or rules out, labeled as an inference |
| Artifact | Safe public link or a note that a local artifact is available |

Never represent a suggested check as completed. Attribute participant-provided results to the participant. When Codex runs a check, record the tool or command plus the relevant public target, timestamp, or revision without publishing a private host path.
