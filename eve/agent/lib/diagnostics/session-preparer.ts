import {
  diagnosticSessionPreparationEnvelopeSchema,
  type DiagnosticSessionPreparationEnvelope,
} from "./envelope.js";
import {
  DiagnosticDomainProfileError,
  getDiagnosticDomainProfile,
} from "./domain-profiles.js";
import { DiagnosticSessionWorkpad } from "./workpad.js";
import {
  DiagnosticSafetyError,
  DiagnosticWorktreeManager,
} from "./worktree.js";

/** Root-controlled input for preparing one diagnostic session. */
export type PrepareDiagnosticSessionInput = {
  domain_id: string;
  report_id: string;
  repository: string;
  issue_number: number;
  request: string;
};

/** Stable outcome Root can surface without exposing a path, branch, or source. */
export type PrepareDiagnosticSessionResult =
  | {
      status: "prepared";
      domain_id: string;
      report_id: string;
      workpad_revision: number;
      delegation_message: string;
    }
  | {
      status: "needs_input";
      domain_id: string;
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
 * The profile registry owns native-skill discovery. This API intentionally does
 * not accept a cwd, branch, source path, backend, or skill name from a model.
 */
export function createDiagnosticSessionPreparer(
  options: DiagnosticSessionPreparerOptions,
): (
  input: PrepareDiagnosticSessionInput,
) => Promise<PrepareDiagnosticSessionResult> {
  return async (input) => {
    try {
      const profile = getDiagnosticDomainProfile(input.domain_id);
      const envelope = diagnosticSessionPreparationEnvelopeSchema.parse({
        schema_version: "failure-report/diagnostic-session/v1",
        ...input,
        native_skill_names: profile.native_skills.map((skill) => skill.name),
      }) as DiagnosticSessionPreparationEnvelope;
      const workpad = new DiagnosticSessionWorkpad({
        worktrees: new DiagnosticWorktreeManager({
          profile,
          backendId: options.backend_id,
          root: options.worktree_root,
        }),
      });
      const prepared = await workpad.prepare(envelope);
      return {
        status: "prepared",
        domain_id: input.domain_id,
        report_id: prepared.report.id,
        workpad_revision: prepared.workpad_revision,
        delegation_message: prepared.delegation_message,
      };
    } catch (error) {
      if (
        error instanceof DiagnosticSafetyError ||
        error instanceof DiagnosticDomainProfileError
      ) {
        return {
          status: "needs_input",
          domain_id: input.domain_id,
          report_id: input.report_id,
          reason: error.message,
        };
      }
      throw error;
    }
  };
}
