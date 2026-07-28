import { defineTool } from "eve/tools";
import { z } from "zod";

import { createFailureReportIntakeRouter } from "../lib/delivery/intake-router.js";

const routeIntake = createFailureReportIntakeRouter();

/**
 * Root-only optional tracker entry. The model identifies only the Issue;
 * target Project coordinates and `Failure Report` come from deployment.
 */
export default defineTool({
  description:
    "Route one accepted GitHub Issue into its target repository's configured Failure Report tracker state, or preserve tracker-free intake when none is configured.",
  inputSchema: z
    .object({
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      issue_number: z.number().int().positive(),
    })
    .strict(),
  async execute(input) {
    return routeIntake(input);
  },
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});
