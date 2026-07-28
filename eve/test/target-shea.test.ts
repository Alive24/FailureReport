import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  prepareTargetSheaWorkspace,
  TargetSheaConfigurationError,
} from "../agent/lib/diagnostics/target-shea.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("target-owned FailureReport .shea workspace", () => {
  it("copies missing defaults and creates the target-local worktree root", async () => {
    const target = await temporaryDirectory();

    const workspace = await prepareTargetSheaWorkspace({
      canonicalCheckout: target,
    });

    expect(workspace.worktree_root).toBe(
      join(await realpath(target), ".shea", "worktrees", "failureReport"),
    );
    expect(workspace.prompts.intake).toContain(
      "Normalize the incoming failure",
    );
    expect(workspace.prompts.synthesis).toContain(
      "Produce an evidence-backed diagnosis",
    );
    expect(await readFile(workspace.handoff_template_path, "utf8")).toContain(
      "{{diagnostic_snapshot}}",
    );
    expect(await readFile(join(target, ".shea", ".gitignore"), "utf8")).toBe(
      "worktrees/failureReport/\n",
    );
  });

  it("preserves target customization instead of overwriting it", async () => {
    const target = await temporaryDirectory();
    const custom = join(
      target,
      ".shea",
      "prompts",
      "failureReport",
      "synthesis.md",
    );
    await mkdir(join(custom, ".."), { recursive: true });
    await writeFile(custom, "# Target-specific synthesis\n", "utf8");

    const workspace = await prepareTargetSheaWorkspace({
      canonicalCheckout: target,
    });

    expect(workspace.prompts.synthesis).toBe("# Target-specific synthesis\n");
    expect(await readFile(custom, "utf8")).toBe(
      "# Target-specific synthesis\n",
    );
  });

  it("loads product defaults from eve/config instead of FailureReport's development .shea", async () => {
    const target = await temporaryDirectory();
    const failureReportRoot = await temporaryDirectory();
    await writeDefaultAssets(failureReportRoot);
    const developmentPrompt = join(
      failureReportRoot,
      ".shea",
      "prompts",
      "failureReport",
      "intake.md",
    );
    await mkdir(join(developmentPrompt, ".."), { recursive: true });
    await writeFile(developmentPrompt, "# Development-only Shea prompt\n");

    const workspace = await prepareTargetSheaWorkspace({
      canonicalCheckout: target,
      failureReportRoot,
    });

    expect(workspace.prompts.intake).toBe("# Authored product intake\n");
    expect(workspace.prompts.intake).not.toContain("Development-only");
  });

  it("fails closed on a symlinked target asset or runtime directory", async () => {
    const target = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const promptDirectory = join(target, ".shea", "prompts", "failureReport");
    await mkdir(promptDirectory, { recursive: true });
    await writeFile(join(outside, "intake.md"), "# Outside\n", "utf8");
    await symlink(
      join(outside, "intake.md"),
      join(promptDirectory, "intake.md"),
    );

    await expect(
      prepareTargetSheaWorkspace({ canonicalCheckout: target }),
    ).rejects.toBeInstanceOf(TargetSheaConfigurationError);
    expect(
      (await lstat(join(promptDirectory, "intake.md"))).isSymbolicLink(),
    ).toBe(true);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "failure-report-target-shea-"));
  temporaryRoots.push(path);
  return path;
}

async function writeDefaultAssets(root: string): Promise<void> {
  const assetRoot = join(root, "eve", "config", "failure-report");
  await mkdir(join(assetRoot, "prompts"), { recursive: true });
  await mkdir(join(assetRoot, "templates"), { recursive: true });
  await writeFile(join(assetRoot, ".gitignore"), "worktrees/failureReport/\n");
  await writeFile(
    join(assetRoot, "prompts", "intake.md"),
    "# Authored product intake\n",
  );
  await writeFile(
    join(assetRoot, "prompts", "synthesis.md"),
    "# Authored product synthesis\n",
  );
  await writeFile(
    join(assetRoot, "templates", "implementation.md"),
    "# Handoff\n\n{{diagnostic_snapshot}}\n",
  );
}
