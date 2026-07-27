import { defineTool } from "eve/tools";
import { z } from "zod";

import { createFailureReportIntakeRouter } from "../lib/delivery/intake-router.js";

const routeIntake = createFailureReportIntakeRouter();

/**
 * Root-only configured tracker entry. The model identifies only the Issue;
 * project coordinates and the `Failure Report` option come from deployment.
 */
export default defineTool({
  description:
    "Route one accepted GitHub Issue into its configured Failure Report tracker state without accepting a caller-selected Project or state.",
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
