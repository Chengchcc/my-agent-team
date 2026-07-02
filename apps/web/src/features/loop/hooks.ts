import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { loopKeys } from "./query-keys";

function loopListQuery() {
  return queryOptions({ queryKey: loopKeys.all, queryFn: api.listLoops });
}

export function useLoopList() {
  return useQuery(loopListQuery());
}

export function useLoopDetail(id: string) {
  return useQuery({
    queryKey: loopKeys.detail(id),
    queryFn: () => api.getLoop(id),
  });
}

export function useCreateLoop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; intent?: string; projectId?: string; cronExpr?: string }) =>
      api.createLoop(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.all }),
  });
}

export function useRunLoop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.runLoop(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: loopKeys.detail(id) });
      qc.invalidateQueries({ queryKey: loopKeys.all });
    },
  });
}

export function useReviewLoopItem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId: string; verdict: string; feedback?: string }) =>
      api.reviewLoopItem(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: loopKeys.detail(id) });
      qc.invalidateQueries({ queryKey: loopKeys.all });
    },
  });
}

export function useDeleteLoop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteLoop(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.all }),
  });
}
