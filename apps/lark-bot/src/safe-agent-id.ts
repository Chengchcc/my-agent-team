/** Replace non-[a-zA-Z0-9_-] chars with _ for filesystem/profile safety.
 *  Identical to DevRunnerRegistry's safeRunnerAgentId rule — single source of truth for agent ID sanitization. */
export function safeAgentId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}
