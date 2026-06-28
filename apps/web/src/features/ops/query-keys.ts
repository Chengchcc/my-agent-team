export const opsKeys = {
  all: ["ops"] as const,
  runs: () => [...opsKeys.all, "runs"] as const,
  runDetail: (id: string) => [...opsKeys.all, "runDetail", id] as const,
  runInsights: (id: string) => [...opsKeys.all, "runInsights", id] as const,
  insightsSummary: (range: { from: number; to: number }) => [...opsKeys.all, "insights", "summary", range] as const,
  sessions: (params?: Record<string, string>) => [...opsKeys.all, "sessions", params ?? {}] as const,
  sessionDetail: (id: string) => [...opsKeys.all, "sessionDetail", id] as const,
  agentRuntime: (id: string) => [...opsKeys.all, "agentRuntime", id] as const,
  surfaces: () => [...opsKeys.all, "surfaces"] as const,
  traceDetail: (id: string) => [...opsKeys.all, "traceDetail", id] as const,
};
