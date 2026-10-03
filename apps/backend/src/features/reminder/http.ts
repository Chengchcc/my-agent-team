import { Elysia, t } from "elysia";
import type { ReminderService } from "./service.js";

/** Web + Lark surface for one-shot nudges. Creation normally arrives through
 *  the remind_me product tool (the agent schedules it from chat); these
 *  routes exist so the web can list and cancel what was scheduled. */
export function reminderRoutes(svc: ReminderService) {
  return new Elysia()
    .get(
      "/api/reminders",
      ({ query }) =>
        query.conversationId
          ? { reminders: svc.listPending(query.conversationId) }
          : { reminders: svc.listAllPending() },
      { query: t.Object({ conversationId: t.Optional(t.String({ minLength: 1 })) }) },
    )
    .post(
      "/api/reminders",
      ({ body, set }) => {
        try {
          const reminder = svc.create({
            conversationId: body.conversationId,
            createdBy: body.createdBy ?? "user",
            text: body.text,
            fireAt: body.fireAt,
          });
          set.status = 201;
          return { reminder };
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "invalid reminder" },
            { status: 400 },
          );
        }
      },
      {
        body: t.Object({
          conversationId: t.String({ minLength: 1 }),
          text: t.String({ minLength: 1 }),
          /** Epoch ms; must be in the future. */
          fireAt: t.Number(),
          createdBy: t.Optional(t.String({ minLength: 1 })),
        }),
      },
    )
    .post(
      "/api/reminders/:id/snooze",
      ({ params: { id }, body, set }) => {
        try {
          return { reminder: svc.snooze(id, body.fireAt) };
        } catch (err) {
          set.status = 400;
          return { error: err instanceof Error ? err.message : "cannot snooze" };
        }
      },
      { body: t.Object({ fireAt: t.Number() }) },
    )
    .delete("/api/reminders/:id", ({ params: { id }, set }) => {
      if (!svc.cancel(id)) {
        set.status = 404;
        return { error: "Not found or already fired" };
      }
      set.status = 204;
      return null;
    });
}
