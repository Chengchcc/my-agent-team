import { useQuery } from "@tanstack/react-query";
import {
  opsAgentRuntimeQuery,
  opsInsightsSummaryQuery,
  opsRunDetailQuery,
  opsRunInsightsQuery,
  opsRunsQuery,
  opsSessionDetailQuery,
  opsSessionsQuery,
  opsSurfacesQuery,
  opsTraceDetailQuery,
} from "./queries";

export function useOpsRuns(params?: Record<string, string>) {
  return useQuery(opsRunsQuery(params));
}

export function useOpsRunDetail(id: string) {
  return useQuery(opsRunDetailQuery(id));
}

export function useOpsRunInsights(id: string) {
  return useQuery(opsRunInsightsQuery(id));
}

/** Single hook for insights summary — 3 chart components share the same cache. */
export function useOpsInsightsSummary(
  range: { from: number; to: number },
  opts?: { refetchInterval?: number },
) {
  return useQuery({ ...opsInsightsSummaryQuery(range), refetchInterval: opts?.refetchInterval });
}

export function useOpsSessions(params?: Record<string, string>) {
  return useQuery(opsSessionsQuery(params));
}

export function useOpsSessionDetail(id: string) {
  return useQuery(opsSessionDetailQuery(id));
}

export function useOpsAgentRuntime(id: string) {
  return useQuery(opsAgentRuntimeQuery(id));
}

export function useOpsSurfaces() {
  return useQuery(opsSurfacesQuery());
}

export function useOpsTraceDetail(id: string) {
  return useQuery(opsTraceDetailQuery(id));
}

export { opsKeys } from "./query-keys";
