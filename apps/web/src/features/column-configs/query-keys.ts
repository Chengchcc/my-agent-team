export const columnConfigKeys = {
  all: ["column-configs"] as const,
  byProject: (projectId: string) => [...columnConfigKeys.all, projectId] as const,
};
