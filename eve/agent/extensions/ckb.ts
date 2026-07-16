import ckb from "@failure-report/ckb-domain-pack";

import backendJson from "../../config/workers/codex-app-server.json" with { type: "json" };

import { parseCodexAppServerBackendConfig } from "../lib/backends/codex-app-server-config.js";
import { createDomainExecutionPreparer } from "../lib/extensions/domain-execution-preparer.js";

/**
 * Consumer mount for the reusable CKB domain extension.
 * The app injects only provider/worktree policy; CKB instructions and tools stay
 * inside the extension and compose under the `ckb__` namespace.
 */
const backend = parseCodexAppServerBackendConfig(backendJson);

export default ckb({
  prepareExecution: createDomainExecutionPreparer<"ckb">({
    backend_id: backend.kind,
    worktree_root: backend.worktree_root,
  }),
});
