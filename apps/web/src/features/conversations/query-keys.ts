export const conversationKeys = {
  all: ["conversations"] as const,
  byAgent: (agentId: string) => [...conversationKeys.all, agentId] as const,
  filtered: (filter: { agentId?: string; requirementId?: string; projectId?: string }) =>
    [...conversationKeys.all, "filtered", filter] as const,
  recent: () => [...conversationKeys.all, "recent"] as const,
  detail: (id: string) => ["conv", id] as const,
  search: (q: string) => [...conversationKeys.all, "search", q] as const,
  inputs: (id: string) => ["conversation-inputs", id] as const,
};
