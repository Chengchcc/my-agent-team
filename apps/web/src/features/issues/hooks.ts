import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { issueKeys } from "./query-keys";

function issueListQuery(filters?: Record<string, unknown>) {
  return queryOptions({ queryKey: issueKeys.list(filters), queryFn: () => api.listIssues(filters?.projectId as string) });
}
function issueDetailQuery(id: string) {
  return queryOptions({ queryKey: issueKeys.detail(id), queryFn: () => api.getIssue(id) });
}
function issueMetaQuery() {
  return queryOptions({ queryKey: issueKeys.meta(), queryFn: api.getIssueMeta });
}

export function useIssueList(filters?: Record<string, unknown>) { return useQuery(issueListQuery(filters)); }
export function useIssueDetail(id: string) { return useQuery(issueDetailQuery(id)); }
export function useIssueMeta() { return useQuery(issueMetaQuery()); }

export function useCreateIssue() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: Record<string, unknown>) => api.createIssue(body as any), onSuccess: () => qc.invalidateQueries({ queryKey: issueKeys.lists() }) });
}
export function useApplyTransition(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (to: string) => api.applyTransition(id, to as any), onSuccess: () => qc.invalidateQueries({ queryKey: issueKeys.lists() }) });
}

export { issueKeys };
