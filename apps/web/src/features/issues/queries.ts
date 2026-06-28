import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { issueKeys } from "./query-keys";

export function issueListQuery(filters?: Record<string, unknown>) {
  return queryOptions({
    queryKey: issueKeys.list(filters),
    queryFn: () => api.listIssues(filters?.projectId as string),
  });
}
export function issueDetailQuery(id: string) {
  return queryOptions({ queryKey: issueKeys.detail(id), queryFn: () => api.getIssueDetail(id) });
}
export function issueMetaQuery() {
  return queryOptions({ queryKey: issueKeys.meta(), queryFn: api.getIssueMeta });
}
