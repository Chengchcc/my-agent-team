import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { columnConfigKeys } from "./query-keys";

export function columnConfigListQuery(projectId: string) {
  return queryOptions({
    queryKey: columnConfigKeys.byProject(projectId),
    queryFn: () => api.listColumnConfigs(projectId),
  });
}
