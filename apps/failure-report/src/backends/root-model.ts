import type { LanguageModel } from "ai";
import { experimental_chatgpt } from "eve/models/openai";

import type { RootBackendConfig } from "../backend-config.js";

export function createRootModel(
  config: RootBackendConfig,
): LanguageModel | string {
  if (config.kind === "experimental_chatgpt") {
    return experimental_chatgpt(config.model);
  }
  return config.model;
}
