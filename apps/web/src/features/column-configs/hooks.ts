import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { columnConfigKeys } from "./query-keys";

function listQuery(projectId: string) {
  return queryOptions({
    queryKey: columnConfigKeys.byProject(projectId),
    queryFn: () => api.listColumnConfigs(projectId),
  });
}
export function useColumnConfigList(projectId: string) {
  return useQuery(listQuery(projectId));
}
export function useUpsertColumnConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.upsertColumnConfig(body as any),
    onSuccess: (_d, v) =>
      qc.invalidateQueries({
        queryKey: columnConfigKeys.byProject((v as any).projectId as string),
      }),
  });
}
export { columnConfigKeys };
