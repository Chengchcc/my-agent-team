import { json } from "../../http/response.js";
import type { RuntimeOpsService } from "./service.js";

export function opsRoutes(svc: RuntimeOpsService) {
  return {
    async listRuns(req: Request): Promise<Response> {
      const url = new URL(req.url);
      return json(
        svc.listRuns({
          agentId: url.searchParams.get("agentId") ?? undefined,
          threadId: url.searchParams.get("threadId") ?? undefined,
          conversationId: url.searchParams.get("conversationId") ?? undefined,
          status: url.searchParams.get("status") ?? undefined,
          limit: url.searchParams.get("limit")
            ? parseInt(url.searchParams.get("limit")!)
            : undefined,
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
      const result = svc.recover(runId);
      return json(result);
    },

    async getAgentRuntime(_req: Request, agentId: string): Promise<Response> {
      // Always returns an object — "unknown" status means no health data yet
      return json(svc.getAgentRuntime(agentId));
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
