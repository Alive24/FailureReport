import rootBackendJson from "../agent/config/backend/root.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { parseRootBackendConfig } from "../src/backend-config.js";

/** Locks in the local-first product provider without making a paid/live model call. */
describe("Root runtime default", () => {
  it("uses the local Codex/ChatGPT-backed Eve model by default without a live call", () => {
    const config = parseRootBackendConfig(rootBackendJson);

    expect(config.kind).toBe("experimental_chatgpt");
    expect(config.model_context_window_tokens).toBeGreaterThan(0);
  });
});
