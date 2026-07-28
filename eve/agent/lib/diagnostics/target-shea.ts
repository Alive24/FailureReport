import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Signals that target-owned FailureReport configuration is unsafe or invalid. */
export class TargetSheaConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetSheaConfigurationError";
  }
}

/** Target-owned configuration and runtime paths prepared from FailureReport defaults. */
export type TargetSheaWorkspace = {
  canonical_checkout: string;
  shea_root: string;
  worktree_root: string;
  prompts: {
    intake: string;
    synthesis: string;
  };
  handoff_template_path: string;
};

const managedAssets = [
  {
    source_path: ".gitignore",
    target_path: join(".shea", ".gitignore"),
    kind: "ignore" as const,
  },
  {
    source_path: join("prompts", "intake.md"),
    target_path: join(".shea", "prompts", "failureReport", "intake.md"),
    kind: "intake" as const,
  },
  {
    source_path: join("prompts", "synthesis.md"),
    target_path: join(".shea", "prompts", "failureReport", "synthesis.md"),
    kind: "synthesis" as const,
  },
  {
    source_path: join("templates", "implementation.md"),
    target_path: join(
      ".shea",
      "template",
      "failureReport",
      "implementation.md",
    ),
    kind: "handoff" as const,
  },
] as const;

/**
 * Materializes FailureReport's target-owned `.shea` contract.
 *
 * Existing target files always win. Only missing known assets are copied from
 * authored `eve/config/failure-report` defaults, and every directory/file is
 * revalidated after creation so symlink or traversal tricks fail closed.
 */
export async function prepareTargetSheaWorkspace(input: {
  canonicalCheckout: string;
  failureReportRoot?: string;
}): Promise<TargetSheaWorkspace> {
  const canonicalCheckout = await validateCanonicalCheckout(
    input.canonicalCheckout,
  );
  const failureReportRoot = await realpath(
    input.failureReportRoot ?? resolveFailureReportRuntimeRoot(),
  );
  const defaultAssetRoot = await realpath(
    join(failureReportRoot, "eve", "config", "failure-report"),
  );
  if (!isPathInside(failureReportRoot, defaultAssetRoot)) {
    throw new TargetSheaConfigurationError(
      "FailureReport's default target assets resolve outside its authored runtime configuration.",
    );
  }

  const sheaRoot = await ensureRealDirectory(
    canonicalCheckout,
    join(canonicalCheckout, ".shea"),
    "target `.shea` directory",
  );
  const promptsRoot = await ensureRealDirectory(
    sheaRoot,
    join(sheaRoot, "prompts"),
    "target `.shea/prompts` directory",
  );
  await ensureRealDirectory(
    promptsRoot,
    join(promptsRoot, "failureReport"),
    "target FailureReport prompt directory",
  );
  const templateRoot = await ensureRealDirectory(
    sheaRoot,
    join(sheaRoot, "template"),
    "target `.shea/template` directory",
  );
  await ensureRealDirectory(
    templateRoot,
    join(templateRoot, "failureReport"),
    "target FailureReport template directory",
  );
  const worktreesRoot = await ensureRealDirectory(
    sheaRoot,
    join(sheaRoot, "worktrees"),
    "target `.shea/worktrees` directory",
  );
  const worktreeRoot = await ensureRealDirectory(
    worktreesRoot,
    join(worktreesRoot, "failureReport"),
    "target FailureReport worktree directory",
  );

  const contents = new Map<(typeof managedAssets)[number]["kind"], string>();
  let handoffTemplatePath = "";
  for (const asset of managedAssets) {
    const source = await validateDefaultAsset(
      failureReportRoot,
      defaultAssetRoot,
      asset.source_path,
    );
    const target = resolve(canonicalCheckout, asset.target_path);
    await copyMissingAsset(source, target);
    const canonicalTarget = await validateTargetAsset(
      canonicalCheckout,
      target,
    );
    const content = await readFile(canonicalTarget, "utf8");
    if (!content.trim()) {
      throw new TargetSheaConfigurationError(
        `Target FailureReport ${asset.kind} asset must not be empty.`,
      );
    }
    contents.set(asset.kind, content);
    if (asset.kind === "handoff") {
      handoffTemplatePath = canonicalTarget;
    }
  }

  const intake = contents.get("intake");
  const synthesis = contents.get("synthesis");
  if (!intake || !synthesis || !handoffTemplatePath) {
    throw new TargetSheaConfigurationError(
      "Target FailureReport `.shea` assets were not prepared completely.",
    );
  }
  return {
    canonical_checkout: canonicalCheckout,
    shea_root: sheaRoot,
    worktree_root: worktreeRoot,
    prompts: { intake, synthesis },
    handoff_template_path: handoffTemplatePath,
  };
}

async function validateCanonicalCheckout(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new TargetSheaConfigurationError(
      "The Root-resolved canonical checkout must be absolute.",
    );
  }
  let declared: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    declared = await lstat(path);
    canonical = await realpath(path);
  } catch {
    throw new TargetSheaConfigurationError(
      "The Root-resolved canonical checkout cannot be inspected safely.",
    );
  }
  if (declared.isSymbolicLink() || !declared.isDirectory()) {
    throw new TargetSheaConfigurationError(
      "The Root-resolved canonical checkout must be a real directory.",
    );
  }
  return canonical;
}

async function ensureRealDirectory(
  parent: string,
  declaredPath: string,
  description: string,
): Promise<string> {
  try {
    await mkdir(declaredPath, { recursive: true });
    const declared = await lstat(declaredPath);
    if (declared.isSymbolicLink() || !declared.isDirectory()) {
      throw new TargetSheaConfigurationError(
        description + " must be a real directory.",
      );
    }
    const canonical = await realpath(declaredPath);
    if (!isPathInside(parent, canonical)) {
      throw new TargetSheaConfigurationError(
        description + " resolves outside its expected parent.",
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof TargetSheaConfigurationError) {
      throw error;
    }
    throw new TargetSheaConfigurationError(
      description + " cannot be created or inspected safely.",
    );
  }
}

async function validateDefaultAsset(
  failureReportRoot: string,
  defaultAssetRoot: string,
  relativePath: string,
): Promise<string> {
  const source = resolve(defaultAssetRoot, relativePath);
  let declared: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    declared = await lstat(source);
    canonical = await realpath(source);
  } catch {
    throw new TargetSheaConfigurationError(
      "A required FailureReport default target asset is missing.",
    );
  }
  if (
    declared.isSymbolicLink() ||
    !declared.isFile() ||
    !isPathInside(failureReportRoot, canonical) ||
    !isPathInside(defaultAssetRoot, canonical)
  ) {
    throw new TargetSheaConfigurationError(
      "A FailureReport default target asset is not a safe regular file.",
    );
  }
  return canonical;
}

async function copyMissingAsset(source: string, target: string): Promise<void> {
  try {
    await lstat(target);
    return;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw new TargetSheaConfigurationError(
        "A target FailureReport `.shea` asset cannot be inspected safely.",
      );
    }
  }
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    // A concurrent Root may have copied the same default. Validation below is
    // authoritative; no existing target content is ever overwritten.
    if (!isAlreadyExistsError(error)) {
      throw new TargetSheaConfigurationError(
        "A missing target FailureReport `.shea` asset could not be copied.",
      );
    }
  }
}

async function validateTargetAsset(
  canonicalCheckout: string,
  target: string,
): Promise<string> {
  let declared: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    declared = await lstat(target);
    canonical = await realpath(target);
  } catch {
    throw new TargetSheaConfigurationError(
      "A target FailureReport `.shea` asset disappeared during validation.",
    );
  }
  if (
    declared.isSymbolicLink() ||
    !declared.isFile() ||
    !isPathInside(canonicalCheckout, canonical)
  ) {
    throw new TargetSheaConfigurationError(
      "A target FailureReport `.shea` asset must be a contained regular file.",
    );
  }
  return canonical;
}

function isPathInside(root: string, path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

function resolveFailureReportRuntimeRoot(): string {
  const candidates = [
    dirname(fileURLToPath(import.meta.url)),
    resolve(process.cwd()),
  ];
  for (const candidate of candidates) {
    const root = findFailureReportRuntimeRoot(candidate);
    if (root) {
      return root;
    }
  }
  throw new TargetSheaConfigurationError(
    "Unable to locate FailureReport's authored target defaults.",
  );
}

function findFailureReportRuntimeRoot(start: string): string | undefined {
  let candidate = resolve(start);
  while (true) {
    if (
      existsSync(join(candidate, "pnpm-workspace.yaml")) &&
      existsSync(join(candidate, "eve", "package.json"))
    ) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return undefined;
    }
    candidate = parent;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
