import { Elysia, t } from "elysia";
import { NotFoundError } from "../../infra/domain-errors.js";
import { parseBoundedLimit } from "../../infra/http-utils.js";
import type { RuntimeOpsService } from "./service.js";

/** Surface-health audit + run telemetry & trace endpoints. Run execution state
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
        return svc.telemetrySummary({
          sinceMs: since !== undefined && Number.isFinite(since) && since > 0 ? since : undefined,
          agentId: query.agentId || undefined,
          modelId: query.modelId || undefined,
          status: query.status || undefined,
          skill: query.skill || undefined,
          scope: query.scope ?? "production",
        });
      },
      {
        query: t.Object({
          since: t.Optional(t.String()),
          agentId: t.Optional(t.String()),
          modelId: t.Optional(t.String()),
          status: t.Optional(t.String()),
          skill: t.Optional(t.String()),
          scope: t.Optional(
            t.Union([t.Literal("production"), t.Literal("eval"), t.Literal("all")]),
          ),
        }),
      },
    )
    .get(
      "/api/agent-runs/:runId/telemetry",
      ({ params: { runId }, query }) => ({
        events: svc.listRunEvents(runId, parseBoundedLimit(query.limit, 500, 2000)),
      }),
      { query: t.Object({ limit: t.Optional(t.String()) }) },
    )
    .get("/api/agent-runs/:runId/trace", ({ params: { runId } }) => {
      const trace = svc.getRunTrace(runId);
      if (!trace) throw new NotFoundError("Run", runId);
      return trace;
    })
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
