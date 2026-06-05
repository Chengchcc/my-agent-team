import { z } from "zod";
import { writeSseDone, writeSseEvent } from "../../infra/sse.js";
import { RunNotFoundError, ThreadBusyError } from "./service.js";

const runSchema = z.object({ input: z.string().min(1) });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function runRoutes(
  svc: ReturnType<typeof import("./service.js").createRunService>,
  buildSpec: (threadId: string, input: string) => Promise<unknown>,
) {
  return {
    async run(req: Request, threadId: string): Promise<Response> {
      const parsed = runSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      try {
        const spec = await buildSpec(threadId, parsed.data.input);
        const stream = svc.start(threadId, parsed.data.input, spec);

        return new Response(
          new ReadableStream({
            async start(controller) {
              try {
                for await (const ev of stream) {
                  writeSseEvent(controller, ev);
                }
                // N1: done is synthesized after stream ends, not detected in-band
                writeSseDone(controller);
                controller.close();
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                controller.enqueue(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
                controller.close();
              }
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          },
        );
      } catch (err: unknown) {
        if (err instanceof ThreadBusyError) return json({ error: err.message }, 409);
        throw err;
      }
    },

    async cancel(_req: Request, runId: string): Promise<Response> {
      try {
        svc.cancel(runId);
        return new Response(null, { status: 204 });
      } catch (err) {
        if (err instanceof RunNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },
  };
}
