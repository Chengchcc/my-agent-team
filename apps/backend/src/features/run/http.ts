import { z } from "zod";
import { json, parseJsonBody, sseResponse } from "../../http/response.js";
import type { RunService } from "./service.js";
import { RunNotFoundError, ThreadBusyError, TooManyRunsError } from "./service.js";

const runSchema = z.object({ input: z.string().min(1) });
const resumeSchema = z.object({ approved: z.boolean(), message: z.string().optional() });

export function runRoutes(
  svc: RunService,
  buildSpec: (
    threadId: string,
    input: string,
    overrides?: {
      runId?: string;
      mode?: "run" | "resume";
      resumeCommand?: { approved: boolean; message?: string };
    },
  ) => Promise<Record<string, unknown>>,
  getThreadIdForRun?: (runId: string) => Promise<string>,
) {
  return {
    /** POST /api/threads/:id/runs → 202 { runId, attemptId } */
    async run(req: Request, threadId: string): Promise<Response> {
      const body = await parseJsonBody(req);
      if ("error" in body) return body.error;
      const parsed = runSchema.safeParse(body.data);
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      try {
        const spec = await buildSpec(threadId, parsed.data.input);
        const { runId, attemptId } = await svc.start(threadId, spec);
        return json({ runId, attemptId }, 202);
      } catch (err) {
        if (err instanceof ThreadBusyError) return json({ error: (err as Error).message }, 409);
        if (err instanceof TooManyRunsError) return json({ error: (err as Error).message }, 429);
        throw err;
      }
    },

    /** POST /api/runs/:id/cancel → 204 */
    async cancel(_req: Request, runId: string): Promise<Response> {
      try {
        svc.cancel(runId);
        return new Response(null, { status: 204 });
      } catch (err) {
        if (err instanceof RunNotFoundError) return json({ error: (err as Error).message }, 404);
        throw err;
      }
    },

    /** GET /api/runs/:id/events → SSE (Last-Event-ID or ?afterSeq= query param) */
    async events(req: Request, runId: string): Promise<Response> {
      // Support both standard Last-Event-ID header and ?afterSeq= query param (browser EventSource compat)
      const qsAfterSeq = new URL(req.url).searchParams.get("afterSeq");
      const afterSeq = qsAfterSeq
        ? parseInt(qsAfterSeq, 10) || 0
        : parseInt(req.headers.get("Last-Event-ID") ?? "0", 10) || 0;
      const stream = svc.eventStream(runId, afterSeq, req.signal);

      return sseResponse(
        stream,
        (rec) => ({
          id: String(rec.seq),
          event: rec.event.type,
          data: rec.event,
        }),
        req.signal,
      );
    },

    /** POST /api/runs/:id/resume → 202 { runId, attemptId } */
    async resume(req: Request, runId: string): Promise<Response> {
      const body = await parseJsonBody(req);
      if ("error" in body) return body.error;
      const parsed = resumeSchema.safeParse(body.data);
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      const threadId = await getThreadIdForRun?.(runId);
      if (!threadId) return json({ error: "Run not found" }, 404);
      try {
        const spec = await buildSpec(threadId, "", {
          runId,
          mode: "resume",
          resumeCommand: parsed.data,
        });
        const { attemptId } = await svc.resume(runId, threadId, spec);
        return json({ runId, attemptId }, 202);
      } catch (err) {
        if (err instanceof RunNotFoundError) return json({ error: (err as Error).message }, 404);
        if (err instanceof TooManyRunsError) return json({ error: (err as Error).message }, 429);
        throw err;
      }
    },

    /** GET /api/runs/:id → run metadata */
    async getById(_req: Request, runId: string): Promise<Response> {
      const meta = svc.getRunById(runId);
      if (!meta) return json({ error: "Run not found" }, 404);
      return json(meta);
    },

    /** D12: GET /api/threads/:id/current-run → { runId, status } | null */
    async currentRun(_req: Request, threadId: string): Promise<Response> {
      const run = svc.getCurrentRun(threadId);
      return json(run);
    },

    /** M13: GET /api/runs/:id/stream → SSE text_delta stream (ephemeral, not EventLog) */
    async stream(_req: Request, runId: string): Promise<Response> {
      const deltaStream = svc.deltaStream(runId);
      return new Response(deltaStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },
  };
}
