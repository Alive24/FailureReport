import { defineAgent } from "eve";

import policyJson from "./config/backend/policy.json" with { type: "json" };

import { parseBackendPolicy } from "../src/backend-policy.js";

const policy = parseBackendPolicy(policyJson);

export default defineAgent({
  model: policy.agent.model,
});
