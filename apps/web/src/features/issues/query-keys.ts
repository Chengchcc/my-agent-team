export const issueKeys = {
  all: ["issues"] as const,
  lists: () => [...issueKeys.all, "list"] as const,
  list: (filters?: Record<string, unknown>) => [...issueKeys.lists(), filters ?? {}] as const,
  details: () => [...issueKeys.all, "detail"] as const,
  detail: (id: string) => [...issueKeys.details(), id] as const,
  meta: () => [...issueKeys.all, "meta"] as const,
};
