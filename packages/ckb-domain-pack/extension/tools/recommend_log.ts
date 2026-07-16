import { defineTool } from "eve/tools";
import { z } from "zod";

import { recommendCkbLog } from "../lib/diagnostics";

const failureLayers = [
  "transaction_assembly",
  "contract_validation",
  "rpc_indexer",
  "nostr_relay",
  "deployment",
  "unknown",
] as const;

/** Returns a bounded CKB diagnostic-log recommendation without external effects. */
export default defineTool({
  description:
    "Recommend one privacy-bounded structured log line for a CKB failure boundary.",
  inputSchema: z
    .object({
      layer: z.enum(failureLayers),
      location: z.string().min(1),
      candidate_fields: z.array(z.string().min(1)).max(20),
    })
    .strict(),
  execute(input) {
    return recommendCkbLog(input.layer, input.location, input.candidate_fields);
  },
});
