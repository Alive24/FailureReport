import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

/**
 * FailureReport's primary public surface.
 *
 * This is Eve's built-in HTTP Channel, not a custom host adapter. It serves the
 * canonical `/eve/v1/session*` routes used directly by the terminal UI, SDK
 * clients, and any outer MCP or Temporal wrapper.
 *
 * Replace `placeholderAuth()` with the deployment's real auth policy before
 * admitting production browser or third-party clients.
 */
export default eveChannel({
  auth: [vercelOidc(), localDev(), placeholderAuth()],
});
