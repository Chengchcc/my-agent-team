export const skillPackKeys = {
  all: ["skill-packs"] as const,
  list: () => [...skillPackKeys.all, "list"] as const,
  detail: (id: string) => [...skillPackKeys.all, "detail", id] as const,
  skills: (id: string) => [...skillPackKeys.all, "skills", id] as const,
  files: (id: string, path?: string) => [...skillPackKeys.all, "files", id, path ?? ""] as const,
  agentPacks: (agentId: string) => [...skillPackKeys.all, "agent", agentId] as const,
};
