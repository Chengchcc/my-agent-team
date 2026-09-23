import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectKeys } from "@/features/projects/query-keys";
import { api, type CodingTerminalRow } from "@/lib/api";
import { codingKeys, codingTerminalsQuery } from "./queries";

export function useCodingTerminals() {
  return useQuery(codingTerminalsQuery());
}

export function useCodingTerminalsList(): CodingTerminalRow[] {
  const { data } = useCodingTerminals();
  return data?.terminals ?? [];
}

function useTerminalMutation<T>(mutationFn: (arg: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: codingKeys.terminals }),
    onError: (err) =>
      toast.error("Terminal operation failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      }),
  });
}

export function useSpawnTerminal() {
  return useTerminalMutation((body: Parameters<typeof api.spawnCodingTerminal>[0]) =>
    api.spawnCodingTerminal(body),
  );
}

export function useCloseTerminal() {
  return useTerminalMutation((id: string) => api.closeCodingTerminal(id));
}

export function useRespawnTerminal() {
  return useTerminalMutation((id: string) => api.respawnCodingTerminal(id));
}

export function useLaunchOma() {
  return useTerminalMutation((id: string) => api.launchOmaInTerminal(id));
}

export function useTaskWorktrees(projectId: string | undefined) {
  return useQuery({
    queryKey: [...codingKeys.all, "task-worktrees", projectId],
    queryFn: () => api.listCodingTaskWorktrees(projectId as string),
    enabled: projectId !== undefined,
  });
}

export function useCreateTaskWorktree(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { agentId: string; slug: string }) =>
      api.createCodingTaskWorktree({ projectId, ...body }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: [...codingKeys.all, "task-worktrees", projectId],
      });
    },
    onError: (err) =>
      toast.error("Worktree creation failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      }),
  });
}

export function useRemoveTaskWorktree(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { agentId: string; slug: string; force?: boolean }) =>
      api.removeCodingTaskWorktree({ projectId, ...body }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: [...codingKeys.all, "task-worktrees", projectId],
      });
      void qc.invalidateQueries({ queryKey: codingKeys.terminals });
    },
  });
}

/** Promote a task worktree into the project's base branch (single
 * branch-ahead move, conflict-preflighted by the backend; local mirror
 * only — push stays an explicit act on the project page). */
export function usePromoteTaskWorktree(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { agentId: string; slug: string }) =>
      api.projectWorktreeMerge(projectId, body.agentId, { push: false, slug: body.slug }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: [...codingKeys.all, "task-worktrees", projectId],
      });
      void qc.invalidateQueries({ queryKey: projectKeys.all });
    },
    onError: (err) =>
      toast.error("Promote failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      }),
  });
}
