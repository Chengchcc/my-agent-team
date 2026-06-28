import { json } from "../../http/response.js";
import { z } from "zod";
import type { RuntimeOpsService } from "./service.js";

const larkHeartbeatSchema = z.object({
  agentId: z.string(),
  status: z.string(),
  payload: z.record(z.unknown()).optional(),
  lastError: z.string().optional(),
});

export function opsRoutes(svc: RuntimeOpsService) {
  return {
    async listRuns(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const raw = url.searchParams.get("limit");
      const limit = raw ? parseInt(raw, 10) : undefined;
      return json(
        svc.listRuns({
          agentId: url.searchParams.get("agentId") ?? undefined,
          sessionId: url.searchParams.get("sessionId") ?? undefined,
          conversationId: url.searchParams.get("conversationId") ?? undefined,
          status: url.searchParams.get("status") ?? undefined,
          traceId: url.searchParams.get("traceId") ?? undefined,
          limit: limit != null && Number.isFinite(limit) && limit > 0 ? limit : undefined,
        }),
      );
    },

    async getRunDetail(_req: Request, spanId: string): Promise<Response> {
      const detail = svc.getRunDetail(spanId);
      if (!detail) return json({ error: "Run not found" }, 404);
      return json(detail);
    },

    // ─── B2: Session-level routes ───

    async listSessions(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const raw = url.searchParams.get("limit");
      const limit = raw ? parseInt(raw, 10) : undefined;
      return json(
        svc.listSessions({
          agentId: url.searchParams.get("agentId") ?? undefined,
          status: url.searchParams.get("status") ?? undefined,
          limit: limit != null && Number.isFinite(limit) && limit > 0 ? limit : undefined,
        }),
      );
    },

    async getSessionDetail(_req: Request, sessionId: string): Promise<Response> {
      const detail = svc.getSessionDetail(sessionId);
      if (!detail) return json({ error: "Session not found" }, 404);
      return json(detail);
    },

    async cancelRun(_req: Request, spanId: string): Promise<Response> {
      const result = svc.cancel(spanId);
      if (!result.ok) return json({ error: result.error }, 404);
      return json(result);
    },

    async recoverRun(_req: Request, spanId: string): Promise<Response> {
      const result = await svc.recover(spanId);
      return json(result);
    },

    async getAgentRuntime(_req: Request, agentId: string): Promise<Response> {
      // Always returns an object — "unknown" status means no health data yet
      return json(svc.getAgentRuntime(agentId));
    },

    async getTraceDetail(_req: Request, traceId: string): Promise<Response> {
      const detail = svc.getTraceDetail(traceId);
      if (!detail) return json({ error: "Trace not found" }, 404);
      return json(detail);
    },

    async listSurfaces(_req: Request): Promise<Response> {
      return json(svc.listSurfaces());
    },

    // ─── M16.3: Run Insights ───

    async getRunInsights(_req: Request, spanId: string): Promise<Response> {
      const insights = await svc.getRunInsights(spanId);
      if (!insights) return json({ error: "Run not found" }, 404);
      return json(insights);
    },

    async getInsightsSummary(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const from = parseInt(url.searchParams.get("from") ?? "", 10);
      const to = parseInt(url.searchParams.get("to") ?? "", 10);
      if (Number.isNaN(from) || Number.isNaN(to))
        return json({ error: "from and to query params required" }, 400);
      return json(await svc.getInsightsSummary({ from, to }));
    },

    /** M16: Internal surface heartbeat endpoint. Payload pre-sanitized by lark-bot. */
    async larkHeartbeat(req: Request): Promise<Response> {
      let body: unknown;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
      const parsed = larkHeartbeatSchema.safeParse(body);
      if (!parsed.success) return json({ error: parsed.error.issues }, 400);
      svc.ingestLarkHeartbeat(parsed.data);
      return json({ ok: true });
    },
  };
}
