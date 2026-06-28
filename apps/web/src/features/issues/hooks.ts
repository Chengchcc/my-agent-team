import type { IssueStatus } from "@my-agent-team/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { issueDetailQuery, issueListQuery, issueMetaQuery } from "./queries";
import { issueKeys } from "./query-keys";

export function useIssueList(filters?: Record<string, unknown>) {
  return useQuery(issueListQuery(filters));
}
export function useIssueDetail(issueId: string, opts?: { enabled?: boolean }) {
  return useQuery({ ...issueDetailQuery(issueId), ...opts });
}
export function useIssueMeta() {
  return useQuery(issueMetaQuery());
}

export function useCreateIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createIssue>[0]) => api.createIssue(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: issueKeys.lists() }),
  });
}
export function useUpdateIssue(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.updateIssue>[1]) => api.updateIssue(issueId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: issueKeys.lists() });
    },
  });
}
export function useDeleteIssue(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteIssue(issueId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: issueKeys.lists() });
    },
  });
}
export function useApplyTransition(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (to: IssueStatus) => api.applyTransition(id, to),
    onSuccess: () => qc.invalidateQueries({ queryKey: issueKeys.lists() }),
  });
}

export { issueKeys };
