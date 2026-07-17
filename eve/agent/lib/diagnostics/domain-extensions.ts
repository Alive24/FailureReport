import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/** A native Codex skill that Root may materialize into a diagnostic worktree. */
export type NativeSkill = {
  name: string;
  source_directory: string;
  source_root: string;
};

/**
 * Fixed Root-owned capability definition for one installed domain extension.
 *
 * An extension supplies domain knowledge and special tools only. Backend
 * selection remains Root session policy, so one diagnosis can safely combine
 * several extensions without coupling them to a particular worker backend.
 */
export type DomainExtension = {
  id: string;
  native_skills: readonly NativeSkill[];
};

/** Raised when Root is asked to use an extension that is not installed locally. */
export class DomainExtensionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainExtensionRegistryError";
  }
}

const require = createRequire(import.meta.url);

/**
 * Resolves a canonical Root-selected extension set from installed packages.
 *
 * The relative path is host policy, not a value accepted from Root's model. This
 * keeps an extension responsible for its skill content while Root controls where
 * and how that content is exposed to the diagnostic worktree.
 */
export function getDomainExtensions(
  extensionIds: readonly string[],
): readonly DomainExtension[] {
  const canonicalIds = canonicalizeDomainExtensionIds(extensionIds);
  const extensions = canonicalIds.map(getDomainExtension);
  assertUniqueNativeSkillNames(extensions);
  return extensions;
}

/** Canonicalizes a Root-selected extension set before it enters durable state. */
export function canonicalizeDomainExtensionIds(
  extensionIds: readonly string[],
): readonly string[] {
  if (extensionIds.length === 0) {
    throw new DomainExtensionRegistryError(
      "At least one diagnostic domain extension must be selected.",
    );
  }
  for (const extensionId of extensionIds) {
    if (!/^[a-z][a-z0-9_-]*$/.test(extensionId)) {
      throw new DomainExtensionRegistryError(
        "Diagnostic domain extension id is invalid: " + extensionId,
      );
    }
  }
  return [...new Set(extensionIds)].sort();
}

/** Resolves one host-registered extension without consulting model-controlled paths. */
function getDomainExtension(extensionId: string): DomainExtension {
  switch (extensionId) {
    case "ckb":
      return {
        id: "ckb",
        native_skills: [
          installedNativeSkill(
            "failure-report-ckb-debugging",
            "@failure-report/ckb-domain-pack",
            "extension/skills/failure-report-ckb-debugging",
          ),
        ],
      };
    default:
      throw new DomainExtensionRegistryError(
        "No installed diagnostic domain extension is registered for: " +
          extensionId,
      );
  }
}

/** Fails closed if two installed extensions attempt to mount the same native skill. */
export function assertUniqueNativeSkillNames(
  extensions: readonly DomainExtension[],
): void {
  const names = new Set<string>();
  for (const extension of extensions) {
    for (const skill of extension.native_skills) {
      if (!/^[a-z][a-z0-9-]*$/.test(skill.name) || names.has(skill.name)) {
        throw new DomainExtensionRegistryError(
          "The selected domain extensions contain a duplicate or invalid native skill: " +
            skill.name,
        );
      }
      names.add(skill.name);
    }
  }
}

/** Resolves a package-owned native skill without consulting model-controlled input. */
function installedNativeSkill(
  name: string,
  packageName: string,
  relativeAssetDirectory: string,
): NativeSkill {
  let entry: string;
  try {
    entry = require.resolve(packageName);
  } catch {
    throw new DomainExtensionRegistryError(
      "The diagnostic domain extension package is not installed: " +
        packageName,
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
