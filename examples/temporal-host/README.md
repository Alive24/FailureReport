# Temporal Host

The Temporal package deliberately separates deterministic Workflow code from external I/O. Register `createFailureReportActivities(rootInvoker)` with a Temporal Worker, where `rootInvoker` calls the default Eve Channel; then start `failureReportWorkflow` with a `RootRequest`.

```ts
import { createFailureReportActivities } from "@failure-report/temporal-adapter";
import type { RootInvoker } from "@failure-report/protocol";

// The Worker owns this integration. It uses `eve/client` (or an equivalent HTTP
// client) to invoke `eve/agent/channels/eve.ts` at `/eve/v1/session*`.
declare const root: RootInvoker;

const activities = createFailureReportActivities(root);
```

The Worker owns `activities`; the Workflow imports only `@failure-report/temporal-adapter/workflow`. The Worker must call the Eve Channel—not import `eve/agent`, a domain extension, or the Codex worker. Eve calls, GitHub reads/writes, filesystem access, MCP operations, and Codex App-server calls remain inside the Activity through Root. Do not duplicate Root routing in the Workflow.

The Root process that performs GitHub I/O uses Octokit by default and obtains its runtime credential from the active `gh auth login` identity once per process. For a centrally operated deployment, token or GitHub App installation credentials can be selected through Root runtime environment configuration instead.
