import type { RootRequest, RootResult } from "@failure-report/protocol";

export interface RootInvoker {
  invoke(request: RootRequest): Promise<RootResult>;
}

export type RootActivities = {
  invokeRoot(request: RootRequest): Promise<RootResult>;
};

export class RootUnavailableError extends Error {
  constructor(message = "FailureReport Root is not available.") {
    super(message);
    this.name = "RootUnavailableError";
  }
}

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
