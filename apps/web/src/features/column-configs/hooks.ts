import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { columnConfigListQuery } from "./queries";
import { columnConfigKeys } from "./query-keys";

export function useColumnConfigList(projectId: string, opts?: { enabled?: boolean }) {
  return useQuery({ ...columnConfigListQuery(projectId), ...opts });
}
export function useUpsertColumnConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.upsertColumnConfig>[0]) =>
      api.upsertColumnConfig(body),
    onSuccess: (_d, v) =>
      qc.invalidateQueries({
        queryKey: columnConfigKeys.byProject(v.projectId),
      }),
  });
}
export function useDeleteColumnConfig(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (configId: string) => api.deleteColumnConfig(configId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: columnConfigKeys.byProject(projectId) });
    },
  });
}
export { columnConfigKeys };
