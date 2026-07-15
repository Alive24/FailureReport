import {
  rootRequestSchema,
  rootResultSchema,
  type RootRequest,
  type RootResult,
} from "@failure-report/protocol";
import type { RootInvoker } from "@failure-report/runtime-port";

export type FailureReportActivities = {
  invokeRoot(request: RootRequest): Promise<RootResult>;
};

export function createFailureReportActivities(
  invoker: RootInvoker,
): FailureReportActivities {
  return {
    async invokeRoot(request) {
      const parsedRequest = rootRequestSchema.parse(request);
      return rootResultSchema.parse(await invoker.invoke(parsedRequest));
    },
  };
}
