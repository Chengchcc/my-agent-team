import { z } from "zod";
import { ThreadBusyError, RunNotFoundError } from "./service.js";

const runSchema = z.object({ input: z.string().min(1) });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function runRoutes(
  svc: ReturnType<typeof import("./service.js").createRunService>,
  buildSpec: (threadId: string, input: string) => Promise<unknown>,
) {
  return {
    async run(req: Request, threadId: string): Promise<Response> {
      const parsed = runSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      try {
        const spec = await buildSpec(threadId, parsed.data.input);
        const stream = svc.start(threadId, parsed.data.input, spec);

        return new Response(
          new ReadableStream({
            async start(controller) {
              try {
                for await (const ev of stream) {
                  if (ev.payload && typeof ev.payload === "object" && "message" in ev.payload && ev.payload.message === "done") {
                    controller.enqueue("event: done\ndata: {}\n\n");
                    break;
                  }
                  controller.enqueue(`event: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
                }
                controller.close();
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                controller.enqueue(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
                controller.close();
              }
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" } },
        );
      } catch (err: any) {
        if (err instanceof ThreadBusyError) return json({ error: err.message }, 409);
        throw err;
      }
    },

    cancel(_req: Request, runId: string): Response {
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
