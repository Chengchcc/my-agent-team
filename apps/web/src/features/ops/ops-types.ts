import type { ApiReturn, api } from "@/lib/api";

/** One row of the run list, as `GET /api/agent-runs` returns it. */
export type AgentRunRow = ApiReturn<typeof api.listAgentRuns>["runs"][number];

/** One row of the surface health list, as `GET /api/ops/surfaces` returns it. */
export type SurfaceRow = ApiReturn<typeof api.listSurfaces>[number];

/** The process metrics, as `GET /api/ops/system-metrics` returns them. */
export type SystemMetricsRow = ApiReturn<typeof api.getSystemMetrics>;
