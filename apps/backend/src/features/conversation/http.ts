import { Elysia, t } from "elysia";
import { sseResponse } from "../../http/response.js";
import type { ConversationService } from "./service.js";
import { ConversationBusyError } from "./service.js";

export function conversationRoutes(svc: ConversationService, idGen: () => string) {
  return (
    new Elysia()
      .get("/api/conversations", ({ query: { agentId } }) => {
        const conversations = agentId
          ? svc.port.listConversationsByAgent(agentId)
          : svc.port.listConversations();
        return conversations;
      })
      .post(
        "/api/conversations",
        async ({ body, set }) => {
          const conversationId = body.conversationId ?? idGen();
          const now = Date.now();
          svc.port.createConversation({
            conversationId,
            triggerMode: body.triggerMode ?? "mention",
            createdAt: now,
          });
          const members = body.members ?? [];
          for (const m of members) {
            await svc.addMember({
              conversationId,
              memberId: m.memberId ?? idGen(),
              kind: m.kind,
              agentId: m.agentId,
              userRef: m.userRef,
              displayName: m.displayName,
            });
          }
          const allMembers = svc.port.getMembers(conversationId);
          set.status = 201;
          return { conversationId, members: allMembers };
        },
        {
          body: t.Object({
            conversationId: t.Optional(t.String({ minLength: 1 })),
            members: t.Optional(
              t.Array(
                t.Object({
                  memberId: t.Optional(t.String({ minLength: 1 })),
                  kind: t.Union([t.Literal("agent"), t.Literal("human")]),
                  agentId: t.Optional(t.String()),
                  userRef: t.Optional(t.String()),
                  displayName: t.Optional(t.String()),
                }),
              ),
            ),
            triggerMode: t.Optional(t.Literal("mention")),
          }),
        },
      )
      .get("/api/conversations/:id", ({ params: { id } }) => {
        const conv = svc.port.getConversation(id);
        if (!conv) return Response.json({ error: "Not found" }, { status: 404 });
        const members = svc.port.getMembers(id);
        return {
          conversationId: conv.conversationId,
          triggerMode: conv.triggerMode,
          hopCount: conv.hopCount,
          title: conv.title,
          members,
        };
      })
      .delete("/api/conversations/:id", ({ params: { id }, set }) => {
        const deleted = svc.port.deleteConversation(id);
        if (!deleted) return Response.json({ error: "Not found" }, { status: 404 });
        set.status = 204;
        return "";
      })
      .post(
        "/api/conversations/:id/messages",
        async ({ params: { id: conversationId }, body, set }) => {
          try {
            const result = await svc.postMessage({
              conversationId,
              senderMemberId: body.senderMemberId,
              addressedTo: body.addressedTo,
              content: body.content,
            });
            set.status = 202;
            return result;
          } catch (err) {
            if (err instanceof ConversationBusyError)
              return Response.json({ error: (err as Error).message }, { status: 409 });
            throw err;
          }
        },
        {
          body: t.Object({
            senderMemberId: t.String({ minLength: 1 }),
            addressedTo: t.Array(t.String()),
            content: t.Any(),
          }),
        },
      )
      .post(
        "/api/conversations/:id/members",
        async ({ params: { id: conversationId }, body }) => {
          const memberId = body.memberId ?? idGen();
          await svc.addMember({
            conversationId,
            memberId,
            kind: body.kind,
            agentId: body.agentId,
            userRef: body.userRef,
            displayName: body.displayName,
          });
          const members = svc.port.getMembers(conversationId);
          return { members };
        },
        {
          body: t.Object({
            memberId: t.Optional(t.String({ minLength: 1 })),
            kind: t.Union([t.Literal("agent"), t.Literal("human")]),
            agentId: t.Optional(t.String()),
            userRef: t.Optional(t.String()),
            displayName: t.Optional(t.String()),
          }),
        },
      )
      .delete(
        "/api/conversations/:id/members",
        async ({ params: { id: conversationId }, body }) => {
          await svc.removeMember(conversationId, body.memberId);
          const members = svc.port.getMembers(conversationId);
          return { members };
        },
        {
          body: t.Object({
            memberId: t.String({ minLength: 1 }),
          }),
        },
      )
      // SSE — returns raw Response (stream, not typed JSON)
      .get("/api/conversations/:id/events", ({ request, params: { id: conversationId } }) => {
        const req = request;
        const qsAfterSeq = new URL(req.url).searchParams.get("afterSeq");
        const afterSeq = qsAfterSeq
          ? parseInt(qsAfterSeq, 10) || 0
          : parseInt(req.headers.get("Last-Event-ID") ?? "0", 10) || 0;
        const stream = svc.subscribeConversation(conversationId, { afterSeq, signal: req.signal });
        return sseResponse(
          stream,
          (entry) => ({ id: String(entry.seq), event: entry.kind, data: entry }),
          req.signal,
        );
      })
      .post(
        "/api/conversations/:id/start-new",
        async ({ params: { id: conversationId }, body, set }) => {
          try {
            const result = await svc.startNewConversationForSurface({
              oldConversationId: conversationId,
              ...body,
            });
            set.status = 201;
            return result;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("run not found") || msg.includes("does not belong"))
              return Response.json({ error: msg }, { status: 404 });
            throw err;
          }
        },
        {
          body: t.Object({
            reason: t.String({ minLength: 1 }),
            title: t.Optional(t.String()),
            requestedByRunId: t.String({ minLength: 1 }),
            idempotencyKey: t.String({ minLength: 1 }),
          }),
        },
      )
  );
}
