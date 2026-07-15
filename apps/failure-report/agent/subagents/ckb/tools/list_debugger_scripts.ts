import { readdir } from "node:fs/promises";

import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

const supportedExtensions = [".sh", ".ts", ".js", ".json", ".md"];

export default defineTool({
  description:
    "List configured CKB debugger scripts so a diagnosis can cite an available reproducible check.",
  inputSchema: z
    .object({
      debugger_root: z.string().min(1).optional(),
      max_results: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  approval: always(),
  async execute(input) {
    const root = input.debugger_root ?? process.env.CKB_DEBUGGER_SCRIPTS_DIR;
    if (!root) {
      throw new Error(
        "Set CKB_DEBUGGER_SCRIPTS_DIR or provide debugger_root before listing scripts.",
      );
    }
    const entries = await readdir(root, { recursive: true });
    const scripts = entries
      .filter((entry) =>
        supportedExtensions.some((extension) => entry.endsWith(extension)),
      )
      .sort();

    return {
      root,
      scripts: scripts.slice(0, input.max_results),
      truncated: scripts.length > input.max_results,
    };
  },
});
