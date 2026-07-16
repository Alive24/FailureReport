import { defineAgent, defineDynamic } from "eve";

import backendJson from "./config/backend/codex-app-server.json" with { type: "json" };

import { parseCkbCodexBackendConfig } from "../../../src/domain-packs/ckb/config.js";
import {
  createBlockedCkbModel,
  createCkbCodexModelResolver,
} from "../../../src/domain-packs/ckb/codex-model.js";

/**
 * Internal CKB Eve declaration.
 * Its dynamic model is intentionally resolved from a Root-prepared envelope so
 * the Codex provider cannot run from an arbitrary message or checkout.
 */
const backend = parseCkbCodexBackendConfig(backendJson);
const resolveModel = createCkbCodexModelResolver(backend);

export default defineAgent({
  description:
    "Diagnose CKB smart-contract, transaction-assembly, Nostr, and debugger-script failures with evidence-backed recommendations.",
  model: defineDynamic({
    fallback: createBlockedCkbModel(),
    events: {
      // Eve invokes this before a model step; the resolver rehydrates durable
      // workpad state and either returns a bound Codex model or fails closed.
      "step.started": (_event, context) => resolveModel(context.messages),
    },
  }),
  modelContextWindowTokens: backend.model_context_window_tokens,
});
