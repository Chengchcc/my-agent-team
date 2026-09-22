import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
    onError: (err) =>
      toast.error("Worktree removal failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      }),
  });
}
