import type { RootInvoker } from "@failure-report/runtime-port";

import {
  EveHttpRootTransport,
  EveRootInvoker,
  InMemoryRootSessionStore,
  type EveRootTransport,
  type RootSessionStore,
} from "./eve-root-invoker.js";

/** Composition root for the public MCP process; domain packs are intentionally absent. */

/** Optional overrides used by tests or a locally configured Eve Root endpoint. */
export type McpRootCompositionOptions = {
  host?: string;
  bearer?: string;
  transport?: EveRootTransport;
  session_store?: RootSessionStore;
};

/**
 * Builds the public MCP-to-Eve Root path with per-process session continuity.
 * It defaults to the local Eve service because FailureReport's MVP runs locally.
 */
export function createMcpRootInvoker(
  options: McpRootCompositionOptions = {},
): RootInvoker {
  const transport =
    options.transport ??
    new EveHttpRootTransport({
      host: options.host ?? "http://127.0.0.1:3000",
      ...(options.bearer ? { auth: { bearer: options.bearer } } : {}),
    });
  return new EveRootInvoker(
    transport,
    options.session_store ?? new InMemoryRootSessionStore(),
  );
}
