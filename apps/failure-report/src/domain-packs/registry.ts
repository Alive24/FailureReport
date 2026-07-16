import ckbBackendJson from "../../agent/subagents/ckb/config/backend/codex-app-server.json" with { type: "json" };

import type { PreparedExecution } from "../execution/workpad.js";
import { parseCkbCodexBackendConfig } from "./ckb/config.js";
import {
  ckbDomainId,
  createCkbExecutionEnvelope,
  createCkbExecutionWorkpad,
} from "./ckb/execution.js";

/**
 * Registry for internal domain execution packs.
 *
 * Root calls this registry after approval; transports do not expose domain IDs as
 * public operations even though Root may select one internally.
 */

/** Root-approved input used to prepare an internal domain execution. */
export type DomainExecutionRequest = {
  domain_id: string;
  report_id: string;
  repository: string;
  issue_number: number;
  request: string;
};

/** Raised when Root names a domain that is not installed in this runtime. */
export class UnknownDomainExecutionError extends Error {
  constructor(domainId: string) {
    super("No configured execution domain pack for: " + domainId);
    this.name = "UnknownDomainExecutionError";
  }
}

/**
 * Selects a domain pack and creates its durable execution preparation.
 * Keeping the selection explicit here makes adding a domain a controlled runtime
 * change rather than an arbitrary model-selected module import.
 */
export async function prepareDomainExecution(
  request: DomainExecutionRequest,
): Promise<PreparedExecution> {
  if (request.domain_id !== ckbDomainId) {
    throw new UnknownDomainExecutionError(request.domain_id);
  }

  // The registry owns pack configuration loading so Root's generic tool never
  // learns backend-specific details such as the Codex provider configuration.
  const config = parseCkbCodexBackendConfig(ckbBackendJson);
  const envelope = createCkbExecutionEnvelope(request);
  return createCkbExecutionWorkpad(config).prepare(envelope);
}
