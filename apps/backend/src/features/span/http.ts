import { z } from "zod";
import { json, parseJsonBody } from "../../http/response.js";
import type { SessionFactory } from "./session-factory.js";

const resumeSchema = z.object({ approved: z.boolean(), message: z.string().optional() });

/**
 * Resume an interrupted run via AgentSession.resume().
 *
 * Looks up the session by spanId → sessionId (via injected getSessionIdByRunId),
 * then retrieves the live session from SessionFactory.peek (never materializes).
 *
 * Session lifecycle is managed by SessionFactory's reaper / explicit close;
 * resume does NOT dispose the session — it persists across spans.
 */
export function resumeRoute(deps: {
  sessionFactory: SessionFactory;
  getSessionIdByRunId: (spanId: string) => string | null;
}) {
  return async (req: Request, spanId: string): Promise<Response> => {
    const body = await parseJsonBody(req);
    if ("error" in body) return body.error;
    const parsed = resumeSchema.safeParse(body.data);
    if (!parsed.success)
      return json({ error: "Validation failed", details: parsed.error.issues }, 400);

    const sessionId = deps.getSessionIdByRunId(spanId);
    if (!sessionId) return json({ error: "Run not found" }, 404);

    const session = deps.sessionFactory.peek(sessionId);
    if (!session) return json({ error: "Session no longer active — already settled" }, 409);

    try {
      await session.resume({ approved: parsed.data.approved, message: parsed.data.message });
      return json({ spanId, resumed: true }, 202);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  };
}
