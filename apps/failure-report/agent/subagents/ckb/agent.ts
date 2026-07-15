import { defineAgent } from "eve";

import policyJson from "./config/backend/policy.json" with { type: "json" };

import { parseBackendPolicy } from "../../../src/backend-policy.js";

const policy = parseBackendPolicy(policyJson);

export default defineAgent({
  description:
    "Diagnose CKB smart-contract, transaction-assembly, Nostr, and debugger-script failures with evidence-backed recommendations.",
  model: policy.agent.model,
});
