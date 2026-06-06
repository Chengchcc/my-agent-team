import { z } from "zod";
import { RunNotFoundError, ThreadBusyError, TooManyRunsError } from "./service.js";

const runSchema = z.object({ input: z.string().min(1) });
const resumeSchema = z.object({ approved: z.boolean(), message: z.string().optional() });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function runRoutes(
  svc: ReturnType<typeof import("./service.js").createRunService>,
  buildSpecJson: (threadId: string, input: string, overrides?: { runId?: string; mode?: "run" | "resume"; resumeCommand?: { approved: boolean; message?: string } }) => Promise<string>,
  getThreadIdForRun?: (runId: string) => Promise<string>,
) {
  return {
    /** POST /api/threads/:id/runs → 202 { runId, attemptId } */
    async run(req: Request, threadId: string): Promise<Response> {
      const parsed = runSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      try {
        const specJson = await buildSpecJson(threadId, parsed.data.input);
        const { runId, attemptId } = svc.start(threadId, parsed.data.input, specJson);
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

    /** GET /api/runs/:id/events → SSE (Last-Event-ID supported) */
    async events(req: Request, runId: string): Promise<Response> {
      const afterSeq = parseInt(req.headers.get("Last-Event-ID") ?? "0", 10) || 0;
      const stream = svc.eventStream(runId, afterSeq, req.signal);

      return new Response(
        new ReadableStream({
          async start(controller) {
            try {
              for await (const rec of stream) {
                const line = `id: ${rec.seq}\nevent: ${rec.event.type}\ndata: ${JSON.stringify(rec.event)}\n\n`;
                controller.enqueue(new TextEncoder().encode(line));
              }
              controller.enqueue(new TextEncoder().encode("event: done\ndata: {}\n\n"));
              controller.close();
            } catch (err) {
              if ((err as Error)?.name === "AbortError") {
                controller.close();
              } else {
                const msg = err instanceof Error ? err.message : String(err);
                controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`));
                controller.close();
              }
            }
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      );
    },

    /** POST /api/runs/:id/resume → 202 { runId, attemptId } */
    async resume(req: Request, runId: string): Promise<Response> {
      const parsed = resumeSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      if (!getThreadIdForRun) return json({ error: "Resume not configured" }, 500);

      try {
        const threadId = await getThreadIdForRun(runId);
        const specJson = await buildSpecJson(threadId, "", {
          runId,
          mode: "resume",
          resumeCommand: parsed.data,
        });
        const { attemptId } = svc.resume(runId, threadId, specJson);
        return json({ runId, attemptId }, 202);
      } catch (err) {
        if (err instanceof RunNotFoundError) return json({ error: (err as Error).message }, 404);
        if (err instanceof TooManyRunsError) return json({ error: (err as Error).message }, 429);
        throw err;
      }
    },

    /** GET /api/runs/:id → run metadata */
    async getById(_req: Request, runId: string): Promise<Response> {
      return json({ runId, status: "see event stream for details" });
    },
  };
}
