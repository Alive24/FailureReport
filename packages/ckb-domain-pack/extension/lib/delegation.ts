/** Appends CKB-specific practice to the generic durable execution envelope. */
export function withCkbDelegationGuidance(envelope: string): string {
  return [
    envelope,
    "",
    "## CKB domain guidance",
    "Diagnose the first failing boundary before proposing a fix. Distinguish transaction assembly, molecule serialization, contract validation, RPC/indexer, Nostr relay, and deployment failures.",
    "When debugger support exists, inspect scripts/debugger/ in the assigned worktree and run the narrowest reproducible script or focused test. Cite the command, its relevant output, and the artifact reference.",
    "For transaction assembly, preserve input/output counts, fee strategy, and hashed script identities but never keys, witnesses, or full cell data. For contract validation, use script hash and group index rather than raw witness payloads. For relay or RPC behavior, record event identifiers and endpoint class rather than content, credentials, headers, or repeated raw responses.",
    "When logging would materially reduce ambiguity, recommend the narrowest structured log line: event, level, location, fields, expected discriminating signal, and privacy or performance cost.",
  ].join("\n");
}
