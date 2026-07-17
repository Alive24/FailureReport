import ckb from "@failure-report/ckb-domain-pack";

/**
 * Consumer mount for the reusable CKB domain extension.
 * CKB stays a pure capability package; Root owns worktree/session/provider policy.
 */
export default ckb();
