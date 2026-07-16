import { defineAgent, type AgentDefinition } from "eve";

import backendJson from "./config/backend/root.json" with { type: "json" };

import { parseRootBackendConfig } from "../src/backend-config.js";
import { createRootModel } from "../src/backends/root-model.js";

/**
 * Eve Root declaration.
 * Backend JSON is parsed at startup so the local-first default and any explicit
 * alternative provider fail early instead of changing agent behavior at runtime.
 */
const backend = parseRootBackendConfig(backendJson);

const agent: AgentDefinition = defineAgent({
  model: createRootModel(backend),
  modelContextWindowTokens: backend.model_context_window_tokens,
});

export default agent;
