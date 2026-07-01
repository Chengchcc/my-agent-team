import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { projectKeys } from "./query-keys";

const listQuery = () => queryOptions({ queryKey: projectKeys.all, queryFn: api.listProjects });
export function useProjectList() {
  return useQuery(listQuery());
}
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createProject>[0]) => api.createProject(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  });
}
export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  });
}
export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateProject>[1] }) =>
      api.updateProject(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  });
}
export { projectKeys };
