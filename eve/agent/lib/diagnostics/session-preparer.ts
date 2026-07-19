import {
  diagnosticSessionPreparationEnvelopeSchema,
  type DiagnosticSessionPreparationEnvelope,
} from "./envelope.js";
import {
  DomainExtensionRegistryError,
  getDomainExtensions,
  type DomainExtension,
} from "./domain-extensions.js";
import {
  createCodexAppServerPreflight,
  type CodexAppServerPreflightFailureCategory,
  type CodexAppServerPreflightResult,
} from "../backends/codex-app-server-preflight.js";
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
      preflight_failure?: CodexAppServerPreflightFailureCategory;
    };

/** Minimal workpad surface used before a diagnostic delegation can be returned. */
export type DiagnosticSessionPreparationWorkpad = Pick<
  DiagnosticSessionWorkpad,
  "prepare" | "loadForDiagnosticSession"
>;

/** Injectable Root-owned seams for focused session-preparer tests. */
export type DiagnosticSessionPreparerDependencies = {
  resolve_domain_extensions?: (
    extensionIds: readonly string[],
  ) => readonly DomainExtension[];
  create_workpad?: (input: {
    domain_extensions: readonly DomainExtension[];
    backend_id: string;
  }) => DiagnosticSessionPreparationWorkpad;
  preflight?: (
    input: Parameters<ReturnType<typeof createCodexAppServerPreflight>>[0],
  ) => Promise<CodexAppServerPreflightResult>;
};

/** Host-only policy required by the generic Root session preparer. */
export type DiagnosticSessionPreparerOptions = {
  backend_id: string;
  codex_path: string;
  dependencies?: DiagnosticSessionPreparerDependencies;
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
  const resolveDomainExtensions =
    options.dependencies?.resolve_domain_extensions ?? getDomainExtensions;
  const preflight =
    options.dependencies?.preflight ?? createCodexAppServerPreflight();

  return async (input) => {
    try {
      const domainExtensions = resolveDomainExtensions(input.domain_extensions);
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
      const workpad =
        options.dependencies?.create_workpad?.({
          domain_extensions: domainExtensions,
          backend_id: options.backend_id,
        }) ??
        new DiagnosticSessionWorkpad({
          worktrees: new DiagnosticWorktreeManager({
            domainExtensions,
            backendId: options.backend_id,
          }),
        });
      const prepared = await workpad.prepare(envelope);
      const readiness = await preflight({
        executable: options.codex_path,
        workspace: {
          path: prepared.diagnostic_session.state.worktree.path,
          native_skill_names: nativeSkillNames,
        },
        // Retry recovery is intentionally limited to the same Root-owned
        // workpad/worktree path. `loadForDiagnosticSession` revalidates that
        // workspace and repairs only a missing Root-selected skill symlink.
        revalidate_workspace: async () => {
          const restored = await workpad.loadForDiagnosticSession({
            ...envelope,
            workpad_revision: prepared.workpad_revision,
          });
          return {
            path: restored.diagnostic_session.state.worktree.path,
            native_skill_names: nativeSkillNames,
          };
        },
      });
      if (readiness.status === "needs_input") {
        return {
          status: "needs_input",
          domain_extensions: domainExtensionIds,
          report_id: prepared.report.id,
          reason: readiness.reason,
          preflight_failure: readiness.category,
        };
      }
      return {
        status: "prepared",
        domain_extensions: domainExtensionIds,
        report_id: prepared.report.id,
        workpad_revision: prepared.workpad_revision,
        delegation_message: prepared.delegation_message,
      };
    } catch (error) {
      if (error instanceof DiagnosticSafetyError) {
        return {
          status: "needs_input",
          domain_extensions: [...input.domain_extensions],
          report_id: input.report_id,
          reason:
            "The Root-owned diagnostic workspace could not be revalidated safely. Revalidate the Root-managed workspace and selected native skills, then retry.",
          preflight_failure: "workspace_invalid",
        };
      }
      if (error instanceof DomainExtensionRegistryError) {
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
