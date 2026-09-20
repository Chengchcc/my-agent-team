import { Elysia, t } from "elysia";
import type { ProductToolsService } from "./service.js";

/** Product Tools auxiliary HTTP routes. The MCP tool surface itself is an
 *  SSE server (createProductToolsMcpServer); this Elysia plugin exposes the
 *  web-callable resolve endpoint for ask_question (HITL ask pipeline). */
export function productToolsRoutes(svc: ProductToolsService) {
  return new Elysia().post(
    "/api/product-tools/ask/resolve",
    ({ body }) => {
      const { runId, callId, answer } = body;
      svc.resolveAsk(runId, callId, answer);
      return { ok: true };
    },
    {
      body: t.Object({
        runId: t.String({ minLength: 1 }),
        callId: t.String({ minLength: 1 }),
        answer: t.Object({
          answers: t.Array(
            t.Object({
              id: t.String(),
              selectedValues: t.Array(t.String()),
              freeText: t.Optional(t.String()),
              // Same contract as the CLI panel (agent-contract
              // AskQuestionAnswerItem): the web surface does not produce these
              // yet, but the wire shape must not be a narrower copy of the
              // contract or a note/timedOut answer would be silently dropped.
              note: t.Optional(t.String()),
              timedOut: t.Optional(t.Boolean()),
            }),
          ),
        }),
      }),
    },
  );
}
