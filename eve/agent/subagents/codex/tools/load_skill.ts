import { disableTool } from "eve/tools";

/**
 * Explicitly disables Eve's default skill-loading tool for the App-server-backed
 * worker. Codex receives domain instructions through the prepared prompt and
 * native shell/MCP capabilities, not AI SDK custom tool schemas.
 */
export default disableTool();
