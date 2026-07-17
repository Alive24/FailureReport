import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/** A native Codex skill that Root may materialize into a diagnostic worktree. */
export type NativeSkillProfile = {
  name: string;
  source_directory: string;
  source_root: string;
};

/** Fixed Root-owned profile for one mounted FailureReport domain. */
export type DiagnosticDomainProfile = {
  domain_id: string;
  native_skills: readonly NativeSkillProfile[];
};

/** Raised when Root is asked to prepare a domain that is not installed locally. */
export class DiagnosticDomainProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticDomainProfileError";
  }
}

const require = createRequire(import.meta.url);

/**
 * Resolves a fixed profile from the host's installed extension package.
 *
 * The relative path is host policy, not a value accepted from Root's model. This
 * keeps an extension responsible for its skill content while Root controls where
 * and how that content is exposed to the diagnostic worktree.
 */
export function getDiagnosticDomainProfile(
  domainId: string,
): DiagnosticDomainProfile {
  switch (domainId) {
    case "ckb":
      return {
        domain_id: "ckb",
        native_skills: [
          installedNativeSkill(
            "failure-report-ckb-debugging",
            "@failure-report/ckb-domain-pack",
            "extension/skills/failure-report-ckb-debugging",
          ),
        ],
      };
    default:
      throw new DiagnosticDomainProfileError(
        "No installed diagnostic domain profile is registered for: " + domainId,
      );
  }
}

/** Resolves a package-owned native skill without consulting model-controlled input. */
function installedNativeSkill(
  name: string,
  packageName: string,
  relativeAssetDirectory: string,
): NativeSkillProfile {
  let entry: string;
  try {
    entry = require.resolve(packageName);
  } catch (error) {
    throw new DiagnosticDomainProfileError(
      "The diagnostic domain package is not installed: " + packageName,
    );
  }

  // The extension package exports its compiled entry from `dist/`; package root
  // is therefore its parent directory. This is resolved from the installed host,
  // never from a report, workpad, or delegation envelope.
  const sourceRoot = resolve(dirname(entry), "..");
  return {
    name,
    source_root: sourceRoot,
    source_directory: join(sourceRoot, relativeAssetDirectory),
  };
}
