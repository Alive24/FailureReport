import { defineAgent, defineDynamic } from "eve";

import backendJson from "./config/backend/codex-app-server.json" with { type: "json" };

import { parseCkbBackendConfig } from "../../../src/backend-config.js";
import {
  createBlockedCkbModel,
  createCkbCodexModelResolver,
} from "../../../src/backends/ckb-codex-model.js";

const backend = parseCkbBackendConfig(backendJson);
const resolveModel = createCkbCodexModelResolver(backend);

export default defineAgent({
  description:
    "Diagnose CKB smart-contract, transaction-assembly, Nostr, and debugger-script failures with evidence-backed recommendations.",
  model: defineDynamic({
    fallback: createBlockedCkbModel(),
    events: {
      "step.started": (_event, context) => resolveModel(context.messages),
    },
  }),
  modelContextWindowTokens: backend.model_context_window_tokens,
});
