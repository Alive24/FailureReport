/** CKB-specific failure boundaries used to select a narrow diagnostic log shape. */
export type CkbFailureLayer =
  | "transaction_assembly"
  | "contract_validation"
  | "rpc_indexer"
  | "nostr_relay"
  | "deployment"
  | "unknown";

/** Structured logging recommendation with privacy and volume guardrails. */
export type CkbLogRecommendation = {
  event: string;
  level: "debug" | "info" | "warn";
  message: string;
  fields: string[];
  rationale: string;
  guardrails: string[];
};

/** Per-layer defaults that keep recommendations consistent across investigations. */
const defaults: Record<
  CkbFailureLayer,
  Omit<CkbLogRecommendation, "fields">
> = {
  transaction_assembly: {
    event: "ckb.transaction.assembly",
    level: "debug",
    message: "Transaction assembly selected inputs, outputs, and fee strategy.",
    rationale:
      "Distinguishes insufficient capacity, change-cell selection, and fee-completion behavior before signing.",
    guardrails: [
      "Do not log private keys, witnesses, or complete cell data.",
      "Hash scripts and truncate capacity lists when they are large.",
    ],
  },
  contract_validation: {
    event: "ckb.contract.validation",
    level: "warn",
    message: "Contract validation observed a failing verification boundary.",
    rationale:
      "Connects the failing script group and error code to the relevant transaction context.",
    guardrails: [
      "Do not log raw witness bytes or user-controlled payloads in full.",
      "Include script hash and group index rather than secret-bearing arguments.",
    ],
  },
  rpc_indexer: {
    event: "ckb.rpc.indexer",
    level: "warn",
    message: "RPC or indexer observation diverged from expected chain state.",
    rationale:
      "Separates stale indexing, node rejection, and query-shape failures.",
    guardrails: [
      "Record endpoint class, not credentials or full authorization headers.",
      "Rate-limit repeated failure logs.",
    ],
  },
  nostr_relay: {
    event: "ckb.nostr.relay",
    level: "warn",
    message:
      "Nostr relay delivery or verification did not reach the expected state.",
    rationale:
      "Shows whether the divergence is event creation, relay acknowledgement, or downstream indexing.",
    guardrails: [
      "Log event identifiers and relay hostnames, not private event content.",
      "Avoid duplicating raw relay responses when they contain user data.",
    ],
  },
  deployment: {
    event: "ckb.deployment",
    level: "info",
    message:
      "Deployment resolution selected a contract and network configuration.",
    rationale:
      "Makes script hash, code hash, network, and deployment-record mismatches observable.",
    guardrails: [
      "Do not log deployment credentials or full configuration files.",
      "Prefer immutable identifiers over transient filesystem paths.",
    ],
  },
  unknown: {
    event: "ckb.failure.boundary",
    level: "debug",
    message: "CKB failure reached an unresolved boundary.",
    rationale:
      "Establishes the first observable boundary before adding narrower diagnostics.",
    guardrails: [
      "Keep the log structured and bounded.",
      "Do not record sensitive transaction material by default.",
    ],
  },
};

/**
 * Produces one deduplicated, bounded structured-log recommendation for a CKB layer.
 * Candidate fields are appended only after the standard correlation fields so every
 * call retains enough context to compare failures without capturing sensitive data.
 */
export function recommendCkbLog(
  layer: CkbFailureLayer,
  location: string,
  candidateFields: string[],
): CkbLogRecommendation {
  const base = defaults[layer];
  return {
    ...base,
    message: base.message + " Location: " + location + ".",
    fields: unique([
      "failure_layer",
      "location",
      "network",
      "transaction_hash",
      ...candidateFields,
    ]),
  };
}

/** Removes empty and repeated fields while preserving their first-seen order. */
function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
