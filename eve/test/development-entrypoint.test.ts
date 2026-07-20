import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import sandbox from "../agent/sandbox.js";

type PackageManifest = {
  dependencies?: Record<string, string>;
  exports?: unknown;
  scripts?: Record<string, string>;
};

const eveRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(eveRoot, "..");
const directWorkspaceBuildPackages = {
  "@failure-report/ckb-domain-pack": "packages/ckb-domain-pack",
  "@failure-report/protocol": "packages/protocol",
} as const;

async function readPackageManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}

function directWorkspaceDependencies(manifest: PackageManifest): string[] {
  return Object.entries(manifest.dependencies ?? {})
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([name]) => name)
    .sort();
}

describe("Eve development entrypoint", () => {
  it("preflights every direct workspace artifact before starting Eve", async () => {
    const evePackage = await readPackageManifest(
      resolve(eveRoot, "package.json"),
    );
    const expectedPackages = Object.keys(directWorkspaceBuildPackages).sort();

    expect(directWorkspaceDependencies(evePackage)).toEqual(expectedPackages);
    expect(evePackage.scripts).toMatchObject({
      test: "vitest run --exclude '**/.eve/**'",
      "dev:preflight":
        "pnpm --filter @failure-report/protocol --filter @failure-report/ckb-domain-pack run build",
      predev: "pnpm run dev:preflight",
      dev: "eve dev --no-ui",
    });
    expect(evePackage.scripts?.["dev:preflight"]).not.toMatch(
      /\b(?:add|install)\b/,
    );

    for (const packagePath of Object.values(directWorkspaceBuildPackages)) {
      const workspacePackage = await readPackageManifest(
        resolve(repositoryRoot, packagePath, "package.json"),
      );

      expect(workspacePackage.scripts?.build).toBeTypeOf("string");
      expect(JSON.stringify(workspacePackage.exports)).toContain("./dist/");
    }
  });

  it("pins just-bash with automatic dependency installation disabled", async () => {
    const sandboxSource = await readFile(
      resolve(eveRoot, "agent/sandbox.ts"),
      "utf8",
    );

    expect(
      (sandbox as unknown as { backend?: { name?: string } }).backend?.name,
    ).toBe("just-bash");
    expect(sandboxSource).toMatch(
      /justbash\s*\(\s*\{\s*autoInstall\s*:\s*false\s*\}\s*\)/,
    );
  });
});
