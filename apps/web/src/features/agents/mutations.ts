import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { agentKeys } from "./query-keys";

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.createAgent(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.lists() }),
  });
}

export function useUpdateAgent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.updateAgent(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentKeys.detail(id) });
      qc.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
}

export function useArchiveAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveAgent(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.lists() }),
  });
}

export function useSetIdentity(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { soul?: string; user?: string }) => api.setIdentity(agentId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.identity(agentId) }),
  });
}
