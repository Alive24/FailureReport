import {
  diagnosticSessionPreparationEnvelopeSchema,
  type DiagnosticSessionPreparationEnvelope,
} from "./envelope.js";
import {
  DomainExtensionRegistryError,
  getDomainExtensions,
} from "./domain-extensions.js";
import { DiagnosticSessionWorkpad } from "./workpad.js";
import {
  DiagnosticSafetyError,
  DiagnosticWorktreeManager,
} from "./worktree.js";

/** Root-controlled input for preparing one diagnostic session. */
export type PrepareDiagnosticSessionInput = {
  domain_extensions: readonly string[];
  report_id: string;
  repository: string;
  issue_number: number;
  request: string;
};

/** Stable outcome Root can surface without exposing a path, branch, or source. */
export type PrepareDiagnosticSessionResult =
  | {
      status: "prepared";
      domain_extensions: readonly string[];
      report_id: string;
      workpad_revision: number;
      delegation_message: string;
    }
  | {
      status: "needs_input";
      domain_extensions: readonly string[];
      report_id: string;
      reason: string;
    };

/** Host-only policy required by the generic Root session preparer. */
export type DiagnosticSessionPreparerOptions = {
  backend_id: string;
  worktree_root?: string;
};

/**
 * Creates Root's only preparation path for a Codex diagnostic session.
 *
 * The extension registry owns native-skill discovery. This API intentionally does
 * not accept a cwd, branch, source path, backend, or skill name from a model.
 */
export function createDiagnosticSessionPreparer(
  options: DiagnosticSessionPreparerOptions,
): (
  input: PrepareDiagnosticSessionInput,
) => Promise<PrepareDiagnosticSessionResult> {
  return async (input) => {
    try {
      const domainExtensions = getDomainExtensions(input.domain_extensions);
      const domainExtensionIds = domainExtensions.map(
        (extension) => extension.id,
      );
      const nativeSkillNames = domainExtensions
        .flatMap((extension) =>
          extension.native_skills.map((skill) => skill.name),
        )
        .sort();
      const envelope = diagnosticSessionPreparationEnvelopeSchema.parse({
        schema_version: "failure-report/diagnostic-session/v1",
        ...input,
        domain_extensions: domainExtensionIds,
        native_skill_names: nativeSkillNames,
      }) as DiagnosticSessionPreparationEnvelope;
      const workpad = new DiagnosticSessionWorkpad({
        worktrees: new DiagnosticWorktreeManager({
          domainExtensions,
          backendId: options.backend_id,
          root: options.worktree_root,
        }),
      });
      const prepared = await workpad.prepare(envelope);
      return {
        status: "prepared",
        domain_extensions: domainExtensionIds,
        report_id: prepared.report.id,
        workpad_revision: prepared.workpad_revision,
        delegation_message: prepared.delegation_message,
      };
    } catch (error) {
      if (
        error instanceof DiagnosticSafetyError ||
        error instanceof DomainExtensionRegistryError
      ) {
        return {
          status: "needs_input",
          domain_extensions: [...input.domain_extensions],
          report_id: input.report_id,
          reason: error.message,
        };
      }
      throw error;
    }
  };
}
