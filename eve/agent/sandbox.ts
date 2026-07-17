import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

/**
 * Eve's Root runs with the dependency-free just-bash backend.
 *
 * It is an orchestration sandbox, not the Git or Codex execution runtime: Root's
 * host-owned diagnostics adapters manage `.eve/sandbox-cache/{sources,worktrees}`
 * and Codex App Server receives the validated worktree directly as its host cwd.
 * Keeping `autoInstall` off avoids a development-time package mutation that could
 * change the checked-in runtime unexpectedly.
 */
export default defineSandbox({
  backend: justbash({ autoInstall: false }),
});
