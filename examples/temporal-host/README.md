# Temporal Host

The Temporal package deliberately separates deterministic Workflow code from
external I/O. Register `createFailureReportActivities(rootInvoker)` with a
Temporal Worker, then start `failureReportWorkflow` with a `RootRequest`.

```ts
import { createFailureReportActivities } from "@failure-report/temporal-adapter";
import { EveHttpRootTransport, EveRootInvoker } from "@failure-report/agent";

const root = new EveRootInvoker(
  new EveHttpRootTransport({ host: process.env.FAILURE_REPORT_EVE_HOST! }),
);

const activities = createFailureReportActivities(root);
```

The Worker owns `activities`; the Workflow imports only
`@failure-report/temporal-adapter/workflow`. Eve calls, GitHub reads/writes,
filesystem access, MCP operations, and Codex App-server calls remain inside the
Activity through Root. Do not import the CKB subagent or duplicate Root routing in
the Workflow.

The Root process that performs GitHub I/O uses Octokit by default and obtains its
runtime credential from the active `gh auth login` identity once per process.
For a centrally operated deployment, token or GitHub App installation credentials
can be selected through Root runtime environment configuration instead.
