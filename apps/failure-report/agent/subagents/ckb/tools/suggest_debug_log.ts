import { defineTool } from "eve/tools";
import { z } from "zod";

import { recommendCkbLog } from "../diagnostics.js";

export default defineTool({
  description:
    "Recommend one narrow, structured CKB diagnostic log that discriminates between likely failure causes.",
  inputSchema: z
    .object({
      failure_layer: z.enum([
        "transaction_assembly",
        "contract_validation",
        "rpc_indexer",
        "nostr_relay",
        "deployment",
        "unknown",
      ]),
      location: z.string().min(1),
      candidate_fields: z.array(z.string().min(1)).max(12).default([]),
    })
    .strict(),
  async execute(input) {
    return recommendCkbLog(
      input.failure_layer,
      input.location,
      input.candidate_fields,
    );
  },
});
