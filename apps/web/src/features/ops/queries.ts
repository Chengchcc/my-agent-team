import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { opsKeys } from "./query-keys";

export function agentRunsQuery(
  params?: Omit<NonNullable<Parameters<typeof api.listAgentRuns>[0]>, "signal">,
) {
  return queryOptions({
    queryKey: opsKeys.runs(params),
    // The signal is per-fetch, not part of the key: a cancelled 15s poll must
    // not outlive the block that asked for it.
    queryFn: ({ signal }) => api.listAgentRuns({ ...params, signal }),
  });
}

export function agentRunDetailQuery(runId: string) {
  return queryOptions({
    queryKey: opsKeys.runDetail(runId),
    queryFn: () => api.getAgentRun(runId),
  });
}

export function agentRuntimeQuery(agentId: string) {
  return queryOptions({
    queryKey: opsKeys.agentRuntime(agentId),
    queryFn: () => api.getAgentRuntime(agentId),
  });
}

export function surfacesQuery() {
  return queryOptions({
    queryKey: opsKeys.surfaces(),
    queryFn: () => api.listSurfaces(),
  });
}

export function telemetrySummaryQuery() {
  return queryOptions({
    queryKey: opsKeys.telemetrySummary(),
    queryFn: () => api.getTelemetrySummary(),
  });
}

export function runEventsQuery(runId: string) {
  return queryOptions({
    queryKey: [...opsKeys.runDetail(runId), "events"] as const,
    queryFn: () => api.getRunTelemetry(runId),
  });
}

export function systemMetricsQuery() {
  return queryOptions({
    queryKey: [...opsKeys.all, "system-metrics"] as const,
    queryFn: () => api.getSystemMetrics(),
    refetchInterval: 15_000,
  });
}

/** Backend round-trip latency in ms, measured through the BFF. */
export function backendPingQuery() {
  return queryOptions({
    queryKey: opsKeys.backendPing(),
    queryFn: async () => {
      const t0 = performance.now();
      await api.listSurfaces();
      return Math.round(performance.now() - t0);
    },
    refetchInterval: 30_000,
    retry: 1,
  });
}
