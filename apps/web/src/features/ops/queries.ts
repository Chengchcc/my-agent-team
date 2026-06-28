import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { opsKeys } from "./query-keys";

export function opsRunsQuery(params?: Record<string, string>) {
  return queryOptions({
    queryKey: opsKeys.runs(),
    queryFn: () => api.listOpsRuns(params as any),
  });
}

export function opsRunDetailQuery(id: string) {
  return queryOptions({
    queryKey: opsKeys.runDetail(id),
    queryFn: () => api.getOpsRunDetail(id),
  });
}

export function opsRunInsightsQuery(id: string) {
  return queryOptions({
    queryKey: opsKeys.runInsights(id),
    queryFn: () => api.getRunInsights(id),
    enabled: !!id,
  });
}

export function opsInsightsSummaryQuery(range: { from: number; to: number }) {
  return queryOptions({
    queryKey: opsKeys.insightsSummary(range),
    queryFn: () => api.getInsightsSummary(range),
  });
}

export function opsSessionsQuery(params?: Record<string, string>) {
  return queryOptions({
    queryKey: opsKeys.sessions(params),
    queryFn: () => api.listOpsSessions(params as any),
  });
}

export function opsSessionDetailQuery(id: string) {
  return queryOptions({
    queryKey: opsKeys.sessionDetail(id),
    queryFn: () => api.getOpsSessionDetail(id),
  });
}

export function opsAgentRuntimeQuery(id: string) {
  return queryOptions({
    queryKey: opsKeys.agentRuntime(id),
    queryFn: () => api.getAgentRuntime(id),
  });
}

export function opsSurfacesQuery() {
  return queryOptions({
    queryKey: opsKeys.surfaces(),
    queryFn: api.listSurfaces,
  });
}

export function opsTraceDetailQuery(id: string) {
  return queryOptions({
    queryKey: opsKeys.traceDetail(id),
    queryFn: () => api.getTraceOpsDetail(id),
  });
}
