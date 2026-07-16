import type { RootRequest, RootResult } from "@failure-report/protocol";

/**
 * Minimal host-facing contract for the one public FailureReport supervisor.
 * Adapters depend on this port rather than an Eve, Codex, or domain-pack detail.
 */
export interface RootInvoker {
  invoke(request: RootRequest): Promise<RootResult>;
}

/** Activity-shaped form of the Root port for durable workflow hosts. */
export type RootActivities = {
  invokeRoot(request: RootRequest): Promise<RootResult>;
};

/** Raised when a host attempts to use a Root implementation that is not bound. */
export class RootUnavailableError extends Error {
  constructor(message = "FailureReport Root is not available.") {
    super(message);
    this.name = "RootUnavailableError";
  }
}

/**
 * Creates a safe placeholder invoker for hosts that have not configured Root yet.
 *
 * It returns a schema-shaped failure instead of throwing so transport adapters can
 * report a clear operational error without inventing backend-specific behavior.
 */
export function createUnavailableRootInvoker(): RootInvoker {
  return {
    async invoke(request) {
      return {
        request_id: request.request_id,
        status: "failed",
        summary: "FailureReport Root has not been bound by this host.",
      };
    },
  };
}
