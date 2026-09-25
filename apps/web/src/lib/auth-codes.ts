/** Wire codes the login route (server) and the login page (client) both need.
 *
 *  Dependency-free on purpose: importing these from `lib/auth` dragged
 *  `node:crypto` into the client bundle, and the login page 500'd with
 *  "Reading from node:crypto is not handled by plugins". */
export const INVALID_PASSWORD = "invalid_password";
