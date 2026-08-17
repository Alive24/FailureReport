import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const pluginRoot = new URL(
  "../../packages/codex-plugin/failure-report/",
  import.meta.url,
);
const manifestFile = new URL(".codex-plugin/plugin.json", pluginRoot);
const mcpConfigFile = new URL(".mcp.json", pluginRoot);
const readmeFile = new URL("README.md", pluginRoot);
const skillsRoot = new URL("skills/", pluginRoot);
const submissionSkillFile = new URL(
  "submit-failure-report/SKILL.md",
  skillsRoot,
);
const evidenceReferenceFile = new URL(
  "submit-failure-report/references/evidence-gathering.md",
  skillsRoot,
);
const submissionMetadataFile = new URL(
  "submit-failure-report/agents/openai.yaml",
  skillsRoot,
);

type PluginManifest = {
  version: string;
  description: string;
  skills: string;
  mcpServers: string;
  interface: {
    shortDescription: string;
    longDescription: string;
    defaultPrompt: string[];
  };
};

type PluginMcpServer = {
  command: string;
  args: string[];
  cwd: string;
  env_vars: string[];
  tool_timeout_sec: number;
};

async function readManifest(): Promise<PluginManifest> {
  return JSON.parse(await readFile(manifestFile, "utf8")) as PluginManifest;
}

describe("FailureReport Codex plugin contract", () => {
  it("packages a directly loadable source MCP server map", async () => {
    const manifest = await readManifest();
    const config = JSON.parse(await readFile(mcpConfigFile, "utf8")) as Record<
      string,
      PluginMcpServer
    >;

    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(Object.keys(config)).toEqual(["failure-report"]);
    expect(config).not.toHaveProperty("mcpServers");
    expect(config).not.toHaveProperty("mcp_servers");
    expect(config["failure-report"]).toMatchObject({
      command: "pnpm",
      args: ["--filter", "@failure-report/mcp-adapter", "mcp"],
      cwd: "../../..",
      tool_timeout_sec: 900,
    });
    expect(config["failure-report"]?.env_vars).toEqual(
      expect.arrayContaining([
        "FAILURE_REPORT_RUNTIME_MODE",
        "FAILURE_REPORT_TRUSTED_REPOSITORIES",
        "FAILURE_REPORT_REMOTE_REPOSITORY",
      ]),
    );
  });

  it("packages the exact repository-owned skill inventory", async () => {
    const manifest = await readManifest();
    const skillDirectories = (
      await readdir(skillsRoot, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(manifest.skills).toBe("./skills/");
    expect(skillDirectories).toEqual([
      "failure-report",
      "submit-failure-report",
    ]);

    await Promise.all(
      skillDirectories.map(async (directory) => {
        const skill = await readFile(
          new URL(`${directory}/SKILL.md`, skillsRoot),
          "utf8",
        );
        expect(skill).toMatch(new RegExp(`^---\\nname: ${directory}\\n`, "u"));
      }),
    );

    const packagedSources = await Promise.all([
      readFile(manifestFile, "utf8"),
      readFile(readmeFile, "utf8"),
      readFile(submissionSkillFile, "utf8"),
      readFile(evidenceReferenceFile, "utf8"),
      readFile(submissionMetadataFile, "utf8"),
    ]);
    for (const source of packagedSources) {
      expect(source).not.toMatch(/\.codex\/plugins\/cache|\/Users\//u);
    }
  });

  it("routes casual symptoms to participant submission from source metadata", async () => {
    const [manifest, skill, metadata, readme] = await Promise.all([
      readManifest(),
      readFile(submissionSkillFile, "utf8"),
      readFile(submissionMetadataFile, "utf8"),
      readFile(readmeFile, "utf8"),
    ]);

    expect(manifest.version).toBe("0.2.0");
    expect(manifest.description).toMatch(/create privacy-safe GitHub Issues/iu);
    expect(manifest.interface.shortDescription).toMatch(
      /report and investigate/iu,
    );
    expect(manifest.interface.longDescription).toMatch(
      /confirmed GitHub Issue creation/iu,
    );
    expect(manifest.interface.defaultPrompt[0]).toMatch(
      /first screen is slow/iu,
    );
    expect(skill).toMatch(/ordinary complaints such as .*this is slow/iu);
    expect(metadata).toContain("$submit-failure-report");
    expect(readme).toMatch(/participant can start naturally/iu);
  });

  it("keeps evidence collection adaptive, bounded, and attributable", async () => {
    const [skill, evidence] = await Promise.all([
      readFile(submissionSkillFile, "utf8"),
      readFile(evidenceReferenceFile, "utf8"),
    ]);

    expect(skill).toContain(
      "Ask no more than three focused questions at a time",
    );
    expect(skill).toMatch(/smallest useful playbook/iu);
    expect(skill).toMatch(/one to five ordered, low-risk checks/iu);
    expect(skill).toMatch(/observed facts, reporter claims, and inferences/iu);
    expect(skill).toMatch(/Do not repeat a fixed questionnaire/iu);
    expect(skill).toMatch(/Stop when another person can reproduce, compare/iu);
    expect(skill).toMatch(/Do not suggest destructive commands/iu);

    for (const heading of [
      "Performance or slow loading",
      "Crash, exception, or failed command",
      "Incorrect result or state",
      "Visual or interaction defect",
      "Intermittent or environment-specific failure",
    ]) {
      expect(evidence).toContain(`## ${heading}`);
    }
    expect(evidence).toMatch(/explicit provenance/iu);
  });

  it("requires duplicate, privacy, full-preview, and confirmation gates", async () => {
    const skill = await readFile(submissionSkillFile, "utf8");

    expect(skill).toMatch(
      /search again .* before proposing any public write/isu,
    );
    expect(skill).toMatch(/duplicate status is unverified/iu);
    expect(skill).toMatch(/private host filesystem paths/iu);
    expect(skill).toMatch(/complete proposed public title and Markdown body/iu);
    expect(skill).toMatch(/explicit confirmation .* after the preview/isu);
    expect(skill).toMatch(/Any content or target change invalidates/iu);
    expect(skill).toMatch(/Issue comment as a public write/iu);
    expect(skill).toMatch(/without claiming publication/iu);
  });

  it("separates report publication from diagnosis and operator internals", async () => {
    const [skill, readme] = await Promise.all([
      readFile(submissionSkillFile, "utf8"),
      readFile(readmeFile, "utf8"),
    ]);

    expect(skill).toMatch(
      /Never ask a reporter about checkout paths, worktrees, branches, SHAs, Eve, MCP, ports/iu,
    );
    expect(skill).toMatch(/Issue creation must remain useful without Eve/iu);
    expect(skill).toMatch(/diagnosis has not started/iu);
    expect(skill).toMatch(/only if the participant then explicitly asks/iu);
    expect(skill).toMatch(/Do not add a FailureReport workpad comment/iu);
    expect(readme).toMatch(/Submission and diagnosis are separate stages/iu);
  });
});
