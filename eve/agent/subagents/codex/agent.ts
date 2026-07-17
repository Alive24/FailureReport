import { defineAgent, defineDynamic } from "eve";

import backendJson from "../../../config/workers/codex-app-server.json" with { type: "json" };

import { parseCodexAppServerBackendConfig } from "../../lib/backends/codex-app-server-config.js";
import {
  createBlockedCodexAppServerModel,
  createCodexAppServerModelResolver,
} from "../../lib/backends/codex-app-server-model.js";

/**
 * Internal consumer-owned Eve declaration.
 * Its dynamic model is intentionally resolved from a Root-prepared envelope so
 * the Codex provider cannot run from an arbitrary message or checkout.
 */
const backend = parseCodexAppServerBackendConfig(backendJson);
const resolveModel = createCodexAppServerModelResolver(backend);

export default defineAgent({
  description:
    "Diagnose a Root-prepared failure in its verified isolated worktree through Codex App Server.",
  model: defineDynamic({
    fallback: createBlockedCodexAppServerModel(),
    events: {
      // Eve invokes this before a model step; the resolver rehydrates durable
      // workpad state and either returns a bound Codex model or fails closed.
      "step.started": (_event, context) => resolveModel(context.messages),
    },
  }),
  modelContextWindowTokens: backend.model_context_window_tokens,
});
