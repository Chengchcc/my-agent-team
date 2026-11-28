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

export function runTraceQuery(runId: string) {
  return queryOptions({
    queryKey: [...opsKeys.runDetail(runId), "trace"] as const,
    queryFn: () => api.getRunTrace(runId),
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

/** Observability time windows (ADR 0085 D3). */
export type OpsWindow = "1h" | "24h" | "7d" | "30d";
export type TelemetryScope = "production" | "eval" | "all";

export interface TelemetryFilter {
  readonly window: OpsWindow;
  readonly agentId?: string;
  readonly modelId?: string;
  readonly status?: string;
  readonly skill?: string;
  readonly scope?: TelemetryScope;
}

const WINDOW_MS: Record<OpsWindow, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export function telemetryWindowQuery(input: OpsWindow | TelemetryFilter) {
  const filter: TelemetryFilter = typeof input === "string" ? { window: input } : input;
  return queryOptions({
    queryKey: [
      ...opsKeys.telemetrySummary(),
      filter.window,
      filter.agentId ?? "",
      filter.modelId ?? "",
      filter.status ?? "",
      filter.skill ?? "",
      filter.scope ?? "production",
    ] as const,
    queryFn: () =>
      api.getTelemetrySummary({
        since: Date.now() - WINDOW_MS[filter.window],
        agentId: filter.agentId,
        modelId: filter.modelId,
        status: filter.status,
        skill: filter.skill,
        scope: filter.scope ?? "production",
      }),
  });
}
