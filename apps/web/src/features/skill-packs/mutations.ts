import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { skillPackKeys } from "./query-keys";

export function useInstallGitPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      description: string;
      url: string;
      ref?: string;
      keepSynced?: boolean;
    }) => api.installSkillPackGit(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillPackKeys.list() }),
  });
}

export function useUploadZipPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description: string; file: File }) =>
      api.uploadSkillPackZip(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillPackKeys.list() }),
  });
}

export function useSyncPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm?: boolean }) =>
      api.syncSkillPack(id, confirm),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillPackKeys.list() }),
  });
}

export function useDeletePack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSkillPack(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillPackKeys.list() }),
  });
}

export function useSetAgentPacks(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (packIds: string[]) => api.setAgentSkillPacks(agentId, { packIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillPackKeys.agentPacks(agentId) });
      queryClient.invalidateQueries({ queryKey: skillPackKeys.list() });
    },
  });
}

type PackAssignment = { agentId: string; packIds: string[] };

/** Rewrites the pack list of each listed member (and only those). One failure leaves the
 *  others saved; the list is refetched either way. */
export function useSetAgentsPacks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (assignments: PackAssignment[]): Promise<void> => {
      for (const assignment of assignments) {
        await api.setAgentSkillPacks(assignment.agentId, { packIds: assignment.packIds });
      }
    },
    onSuccess: (_result, assignments) => {
      for (const assignment of assignments) {
        queryClient.invalidateQueries({ queryKey: skillPackKeys.agentPacks(assignment.agentId) });
      }
      queryClient.invalidateQueries({ queryKey: skillPackKeys.list() });
    },
  });
}
