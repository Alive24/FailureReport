import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const workflowFile = new URL(
  "../../.shea/workflows/shea-symphony.md",
  import.meta.url,
);
const mainPromptFile = new URL(
  "../../.shea/prompts/main-agent.md",
  import.meta.url,
);
const reviewPromptFile = new URL(
  "../../.shea/prompts/review-agent.md",
  import.meta.url,
);
const mergePromptFile = new URL(
  "../../.shea/prompts/merge-agent.md",
  import.meta.url,
);

/** Keeps the target-owned Shea configuration aligned with this Node repository. */
describe("FailureReport Shea workflow contract", () => {
  it("uses portable commands and the repository verification suite", async () => {
    const workflow = await readFile(workflowFile, "utf8");

    expect(workflow).toContain("repo: FailureReport");
    expect(workflow).toContain("project_number: 10");
    expect(workflow).toContain("review_agent_command: agy");
    expect(workflow).toContain("agy_command: agy");
    expect(workflow).toContain("- pnpm build");
    expect(workflow).toContain("- pnpm check");
    expect(workflow).toContain("- pnpm test");
    expect(workflow).toContain("- pnpm format:check");
    expect(workflow).not.toMatch(/\/(?:Users|Volumes)\//);
  });

  it("keeps lane prompts FailureReport-specific without upstream assumptions", async () => {
    const [main, review, merge] = await Promise.all([
      readFile(mainPromptFile, "utf8"),
      readFile(reviewPromptFile, "utf8"),
      readFile(mergePromptFile, "utf8"),
    ]);
    const prompts = [main, review, merge].join("\n");

    expect(main).toContain("FailureReport issue {{ issue.identifier }}");
    expect(main).toContain("GitHub Project v2 project #10");
    expect(main).toContain("`pnpm build`, `pnpm check`, `pnpm test`");
    expect(review).toContain("FailureReport issue {{ issue.identifier }}");
    expect(merge).toContain("FailureReport issue {{ issue.identifier }}");
    expect(prompts).toContain(".shea/workflows/shea-symphony.md");
    expect(prompts).not.toContain("project #9");
    expect(prompts).not.toContain("docs/bootstrap/");
    expect(prompts).not.toMatch(/\bcargo\b/i);
    expect(prompts).not.toMatch(/\brust(?:doc)?\b/i);
  });
});
