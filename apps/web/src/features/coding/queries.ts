import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const codingKeys = {
  all: ["coding"] as const,
  terminals: ["coding", "terminals"] as const,
  workspaces: ["coding", "workspaces"] as const,
  worktreeDiff: (projectId: string, workspaceId: string) =>
    ["coding", "worktree-diff", projectId, workspaceId] as const,
};

export const codingTerminalsQuery = () =>
  queryOptions({
    queryKey: codingKeys.terminals,
    queryFn: ({ signal }) => api.listCodingTerminals(signal),
    // Terminal status (running/exited/agentState) is display state —
    // a short poll keeps the rail dots honest; live output rides the WS.
    refetchInterval: 4000,
  });

export const codingWorkspacesQuery = () =>
  queryOptions({
    queryKey: codingKeys.workspaces,
    queryFn: ({ signal }) => api.listCodingWorkspaces(signal),
    refetchInterval: 4000,
  });

export const codingWorktreeDiffQuery = (projectId: string, workspaceId: string) =>
  queryOptions({
    queryKey: codingKeys.worktreeDiff(projectId, workspaceId),
    queryFn: () => api.projectWorktreeDiff(projectId, workspaceId),
  });
