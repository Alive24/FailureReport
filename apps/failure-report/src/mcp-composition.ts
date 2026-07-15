import type { RootInvoker } from "@failure-report/runtime-port";

import {
  EveHttpRootTransport,
  EveRootInvoker,
  InMemoryRootSessionStore,
  type EveRootTransport,
  type RootSessionStore,
} from "./eve-root-invoker.js";

export type McpRootCompositionOptions = {
  host?: string;
  bearer?: string;
  transport?: EveRootTransport;
  session_store?: RootSessionStore;
};

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
