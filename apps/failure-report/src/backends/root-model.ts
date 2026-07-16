import type { LanguageModel } from "ai";
import { experimental_chatgpt } from "eve/models/openai";

import type { RootBackendConfig } from "../backend-config.js";

/**
 * Builds Root's tool-capable model from validated local configuration.
 *
 * Returning a provider-specific `LanguageModel` for the local default preserves
 * Eve tool calling; a string is retained only for Eve's configured gateway path.
 */
export function createRootModel(
  config: RootBackendConfig,
): LanguageModel | string {
  if (config.kind === "experimental_chatgpt") {
    return experimental_chatgpt(config.model);
  }
  return config.model;
}
