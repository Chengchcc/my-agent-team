/** Validate an agentId for use in filesystem paths. */
export function safeAgentId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`invalid agentId: "${id}" — contains characters outside [a-zA-Z0-9_-]`);
  }
  return id;
}
