import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { projectKeys } from "./query-keys";

const listQuery = () => queryOptions({ queryKey: projectKeys.all, queryFn: api.listProjects });
export function useProjectList() { return useQuery(listQuery()); }
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: Record<string, unknown>) => api.createProject(body as any), onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }) });
}
export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.deleteProject(id), onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }) });
}
export { projectKeys };
