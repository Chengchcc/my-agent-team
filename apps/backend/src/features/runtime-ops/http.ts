import { json } from "../../http/response.js";
import type { RuntimeOpsService } from "./service.js";

export function opsRoutes(svc: RuntimeOpsService) {
  return {
    async listRuns(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const raw = url.searchParams.get("limit");
      const limit = raw ? parseInt(raw, 10) : undefined;
      return json(
        svc.listRuns({
          agentId: url.searchParams.get("agentId") ?? undefined,
          threadId: url.searchParams.get("threadId") ?? undefined,
          conversationId: url.searchParams.get("conversationId") ?? undefined,
          status: url.searchParams.get("status") ?? undefined,
          transport:
            (url.searchParams.get("transport") as "attached" | "noop" | "detached" | null) ??
            undefined,
          heartbeat: (url.searchParams.get("heartbeat") as "fresh" | "stale" | null) ?? undefined,
          traceId: url.searchParams.get("traceId") ?? undefined,
          limit: limit != null && Number.isFinite(limit) && limit > 0 ? limit : undefined,
        }),
      );
    },

    async getRunDetail(_req: Request, runId: string): Promise<Response> {
      const detail = svc.getRunDetail(runId);
      if (!detail) return json({ error: "Run not found" }, 404);
      return json(detail);
    },

    async cancelRun(_req: Request, runId: string): Promise<Response> {
      const result = svc.cancel(runId);
      if (!result.ok) return json({ error: result.error }, 404);
      return json(result);
    },

    async recoverRun(_req: Request, runId: string): Promise<Response> {
      const result = await svc.recover(runId);
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

    async getRunInsights(_req: Request, runId: string): Promise<Response> {
      const insights = await svc.getRunInsights(runId);
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
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!body.agentId || typeof body.agentId !== "string") {
        return json({ error: "Missing required field: agentId" }, 400);
      }
      if (!body.status || typeof body.status !== "string") {
        return json({ error: "Missing required field: status" }, 400);
      }
      svc.ingestLarkHeartbeat(body as Parameters<typeof svc.ingestLarkHeartbeat>[0]);
      return json({ ok: true });
    },
  };
}
