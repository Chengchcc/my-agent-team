import { Elysia, t } from "elysia";
import { parseBoundedLimit } from "../../infra/http-utils.js";
import type { RuntimeOpsService } from "./service.js";

/** Surface-health audit + run telemetry endpoints. Run execution state
 *  lives under /api/agent-runs (Agent Run is the sole execution identity);
 *  telemetry is the durable normalized event log written by execution. */
export function opsRoutes(svc: RuntimeOpsService) {
  return new Elysia()
    .get("/api/ops/agents/:id/runtime", ({ params: { id } }) => svc.getAgentRuntime(id))
    .get("/api/ops/surfaces", () => svc.listSurfaces())
    .get("/api/ops/system-metrics", () => svc.getSystemMetrics())
    .get(
      "/api/telemetry/summary",
      ({ query }) => {
        const since = query.since ? Number(query.since) : undefined;
        return svc.telemetrySummary(
          since !== undefined && Number.isFinite(since) && since > 0 ? since : undefined,
        );
      },
      { query: t.Object({ since: t.Optional(t.String()) }) },
    )
    .get(
      "/api/agent-runs/:runId/telemetry",
      ({ params: { runId }, query }) => ({
        events: svc.listRunEvents(runId, parseBoundedLimit(query.limit, 500, 2000)),
      }),
      { query: t.Object({ limit: t.Optional(t.String()) }) },
    )
    .post(
      "/api/internal/surfaces/lark/heartbeat",
      ({ body }) => {
        svc.ingestLarkHeartbeat(body);
        return { ok: true };
      },
      {
        body: t.Object({
          agentId: t.String(),
          status: t.String(),
          payload: t.Optional(t.Record(t.String(), t.Any())),
          lastError: t.Optional(t.String()),
        }),
      },
    );
}
