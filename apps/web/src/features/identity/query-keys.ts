export const identityKeys = {
  byAgent: (agentId: string) => ["identity", agentId] as const,
};
