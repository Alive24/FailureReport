import {
  rootRequestSchema,
  rootResultSchema,
  type RootRequest,
  type RootInvoker,
  type RootResult,
} from "@failure-report/protocol";

/**
 * Nondeterministic boundary invoked by the deterministic Temporal workflow.
 * Root, Eve, GitHub, filesystem, and Codex calls must stay behind this boundary.
 */
export type FailureReportActivities = {
  invokeRoot(request: RootRequest): Promise<RootResult>;
};

/**
 * Creates Temporal activity implementations around a host-provided Root invoker.
 * The schemas are rechecked here because activity inputs may be replayed or come
 * from a worker that is not the original adapter process.
 */
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
