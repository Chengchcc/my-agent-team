import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cronKeys } from "./query-keys";

function cronListQuery() { return queryOptions({ queryKey: cronKeys.all, queryFn: api.listCronJobs }); }
export function useCronList() { return useQuery(cronListQuery()); }
export function useCreateCronJob() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: Record<string, unknown>) => api.createCronJob(body as any), onSuccess: () => qc.invalidateQueries({ queryKey: cronKeys.all }) });
}
export function useDeleteCronJob() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.deleteCronJob(id), onSuccess: () => qc.invalidateQueries({ queryKey: cronKeys.all }) });
}
export function useSetCronEnabled() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setCronJobEnabled(id, enabled), onSuccess: () => qc.invalidateQueries({ queryKey: cronKeys.all }) });
}
export { cronKeys };
