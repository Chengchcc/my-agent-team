import { Elysia, t } from "elysia";
import type { ProactiveService } from "./service.js";

/** Read model for the ambient event ledger (ADR 0046): "what the agent
 *  would have done / did do" for rule matches. Read-only — rules live in
 *  the agent config (`PATCH /api/agents/:id`), events are append-only. */
export function proactiveRoutes(svc: ProactiveService) {
  return new Elysia().get(
    "/api/proactive/events",
    ({ query }) => ({
      events: svc.listEvents({
        agentId: query.agentId !== "" ? query.agentId : undefined,
        limit: query.limit,
      }),
    }),
    {
      query: t.Object({
        agentId: t.Optional(t.String({ minLength: 1 })),
        limit: t.Optional(t.Number({ minimum: 1, maximum: 200 })),
      }),
    },
  );
}
