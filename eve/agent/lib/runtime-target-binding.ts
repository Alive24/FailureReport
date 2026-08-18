/** Private repository identity derived from the process-bound target checkout. */
export const targetRepositoryEnvironmentVariable =
  "FAILURE_REPORT_TARGET_REPOSITORY";

/** Private immutable commit derived from the process-bound target checkout. */
export const targetRevisionEnvironmentVariable =
  "FAILURE_REPORT_TARGET_REVISION";

export type RuntimeTargetBinding = {
  repository: string;
  revision: string;
};

/** Signals that Eve cannot prove the repository and revision it privately owns. */
export class RuntimeTargetBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeTargetBindingError";
  }
}

/**
 * Reads only launcher-owned environment state. Public Root requests cannot add
 * a repository, revision, branch, selector, or checkout path to this binding.
 */
export function readRuntimeTargetBinding(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  expectedRepository?: string,
): RuntimeTargetBinding {
  const repository = environment[targetRepositoryEnvironmentVariable]?.trim();
  const revision = environment[targetRevisionEnvironmentVariable]?.trim();
  if (
    !repository ||
    !/^[^/\s]+\/[^/\s]+$/.test(repository) ||
    !revision ||
    !/^[0-9a-f]{40,64}$/i.test(revision)
  ) {
    throw new RuntimeTargetBindingError(
      "FailureReport's private runtime target binding is unavailable. Restart Eve from the verified target checkout before retrying.",
    );
  }
  if (expectedRepository && repository !== expectedRepository) {
    throw new RuntimeTargetBindingError(
      "The Issue repository does not match FailureReport's private runtime target binding.",
    );
  }
  return { repository, revision: revision.toLowerCase() };
}
