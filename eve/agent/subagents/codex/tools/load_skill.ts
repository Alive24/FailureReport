import { disableTool } from "eve/tools";

/**
 * Explicitly disables Eve's default skill-loading tool for the App-server-backed
 * worker. Root materializes selected native skills under `.agents/skills` in the
 * diagnostic worktree and the prepared delegation invokes them with `$name`.
 * Codex uses native skills, shell, Git, and MCP rather than Eve tool schemas.
 */
export default disableTool();
