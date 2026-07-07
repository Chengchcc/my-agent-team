export const conversationKeys = {
  all: ["conversations"] as const,
  byAgent: (agentId: string) => [...conversationKeys.all, agentId] as const,
  recent: () => [...conversationKeys.all, "recent"] as const,
  detail: (id: string) => ["conv", id] as const,
};
