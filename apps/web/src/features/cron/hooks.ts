import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cronKeys } from "./query-keys";

function cronListQuery() {
  return queryOptions({ queryKey: cronKeys.all, queryFn: api.listCronJobs });
}
export function useCronList() {
  return useQuery(cronListQuery());
}
export function useCreateCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createCronJob>[0]) => api.createCronJob(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: cronKeys.all });
      qc.invalidateQueries({ queryKey: ["loops"] });
    },
  });
}
export function useDeleteCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteCronJob(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: cronKeys.all });
      qc.invalidateQueries({ queryKey: ["loops"] });
    },
  });
}
export function useSetCronEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setCronJobEnabled(id, enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: cronKeys.all });
      qc.invalidateQueries({ queryKey: ["loops"] });
    },
  });
}
export function useUpdateCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateCronJob>[1] }) =>
      api.updateCronJob(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: cronKeys.all });
      qc.invalidateQueries({ queryKey: ["loops"] });
    },
  });
}
export { cronKeys };
