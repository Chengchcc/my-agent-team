import { Elysia, t } from "elysia";
import type { SessionFactory } from "./session-factory.js";

/**
 * Resume an interrupted run via AgentSession.resume().
 *
 * Looks up the session by spanId (params.id) → sessionId (via injected getSessionIdByRunId),
 * then retrieves the live session from SessionFactory.peek (never materializes).
 *
 * Session lifecycle is managed by SessionFactory's reaper / explicit close;
 * resume does NOT dispose the session — it persists across spans.
 */
export function resumeRoutes(deps: {
  sessionFactory: SessionFactory;
  getSessionIdByRunId: (spanId: string) => string | null;
}) {
  return new Elysia().post(
    "/api/runs/:id/resume",
    async ({ params: { id }, body }) => {
      const sessionId = deps.getSessionIdByRunId(id);
      if (!sessionId) return Response.json({ error: "Run not found" }, { status: 404 });

      const session = deps.sessionFactory.peek(sessionId);
      if (!session)
        return Response.json(
          { error: "Session no longer active — already settled" },
          { status: 409 },
        );

      try {
        await session.resume({ approved: body.approved, message: body.message });
        return { spanId: id, resumed: true };
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    },
    {
      body: t.Object({
        approved: t.Boolean(),
        message: t.Optional(t.String()),
      }),
    },
  );
}
