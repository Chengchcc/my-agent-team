import { Elysia, t } from "elysia";
import type { RuntimeOpsService } from "./service.js";

export function opsRoutes(svc: RuntimeOpsService) {
  return new Elysia()
    .get("/api/ops/sessions", ({ query }) => svc.listSessions(query))
    .get("/api/ops/sessions/:id", ({ params: { id } }) => {
      const detail = svc.getSessionDetail(id);
      if (!detail) return Response.json({ error: "Session not found" }, { status: 404 });
      return detail;
    })
    .get("/api/ops/runs", ({ query }) => svc.listRuns(query))
    .get("/api/ops/runs/:id", ({ params: { id } }) => {
      const detail = svc.getRunDetail(id);
      if (!detail) return Response.json({ error: "Run not found" }, { status: 404 });
      return detail;
    })
    .post("/api/ops/runs/:id/cancel", ({ params: { id } }) => {
      const result = svc.cancel(id);
      if (!result.ok) return Response.json({ error: result.error }, { status: 404 });
      return result;
    })
    .post("/api/ops/runs/:id/recover", ({ params: { id } }) => svc.recover(id))
    .get("/api/ops/runs/:id/insights", async ({ params: { id } }) => {
      const insights = await svc.getRunInsights(id);
      if (!insights) return Response.json({ error: "Run not found" }, { status: 404 });
      return insights;
    })
    .get("/api/ops/insights/summary", ({ query: { from, to } }) => {
      const fromTs = parseInt(from ?? "", 10);
      const toTs = parseInt(to ?? "", 10);
      if (Number.isNaN(fromTs) || Number.isNaN(toTs))
        return Response.json({ error: "from and to query params required" }, { status: 400 });
      return svc.getInsightsSummary({ from: fromTs, to: toTs });
    })
    .get("/api/ops/agents/:id/runtime", ({ params: { id } }) => svc.getAgentRuntime(id))
    .get("/api/ops/traces/:id", ({ params: { id } }) => {
      const detail = svc.getTraceDetail(id);
      if (!detail) return Response.json({ error: "Trace not found" }, { status: 404 });
      return detail;
    })
    .get("/api/ops/surfaces", () => svc.listSurfaces())
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
