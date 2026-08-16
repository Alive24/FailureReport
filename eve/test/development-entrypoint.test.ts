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
        "pnpm --filter @failure-report/protocol --filter @failure-report/ckb-domain-pack run build && tsc -p tsconfig.json",
      predev: "pnpm run dev:preflight",
      dev: "node ./scripts/dev.mjs",
      "runtime:build":
        "pnpm run dev:preflight && pnpm exec eve build --skip-sandbox-prewarm",
      prestart: "pnpm run runtime:build",
      start: "node ./scripts/start.mjs",
      "demo:start": "node ./scripts/demo-start.mjs",
    });
    expect(evePackage.dependencies?.["@inference/tracing"]).toBe("0.1.8");
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

    const launcher = await readFile(
      resolve(eveRoot, "scripts/runtime-launcher.mjs"),
      "utf8",
    );
    expect(launcher).toContain("--target-workspace");
    expect(launcher).toContain("FAILURE_REPORT_TARGET_WORKSPACE");
    expect(launcher).toContain('["dev", "--no-ui"');
    expect(launcher).toContain('"start"');
    expect(launcher).toContain("host-runtime-preflight-cli.js");
    expect(launcher).toContain("watcher_exhaustion");
    expect(launcher).toContain(".failure-report-runtime");
    expect(launcher).toContain("createPersistentRuntimeRoot");

    const supportedStart = await readFile(
      resolve(eveRoot, "scripts/start.mjs"),
      "utf8",
    );
    expect(supportedStart).toContain('mode: "production"');
    expect(supportedStart).not.toContain('mode: "demo"');

    const instrumentation = await readFile(
      resolve(eveRoot, "agent/instrumentation.ts"),
      "utf8",
    );
    expect(instrumentation).toContain("defineCatalystEveInstrumentation");
    expect(instrumentation).toContain(
      'process.env.FAILURE_REPORT_REAL_TRACE_CAPTURE === "1"',
    );
    expect(instrumentation).toContain("recordInputs: false");
    expect(instrumentation).toContain("recordOutputs: false");
    expect(instrumentation).toContain('batching: "simple"');
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
