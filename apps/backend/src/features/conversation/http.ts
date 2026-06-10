import { z } from "zod";
import { ConversationBusyError } from "./service.js";
import { json, sseResponse } from "../../http/response.js";

const createSchema = z.object({
  conversationId: z.string().min(1).optional(),
  members: z
    .array(
      z.object({
        memberId: z.string().min(1).optional(),
        kind: z.enum(["agent", "human"]),
        agentId: z.string().optional(),
        userRef: z.string().optional(),
        displayName: z.string().optional(),
      }),
    )
    .optional(),
  triggerMode: z.enum(["mention"]).optional(), // L3: 'all' rejected until M12 implements
});

const addMemberSchema = z.object({
  memberId: z.string().min(1).optional(),
  kind: z.enum(["agent", "human"]),
  agentId: z.string().optional(),
  userRef: z.string().optional(),
  displayName: z.string().optional(),
});

const removeMemberSchema = z.object({
  memberId: z.string().min(1),
});

const messageSchema = z.object({
  senderMemberId: z.string().min(1),
  addressedTo: z.array(z.string()).default([]),
  content: z.unknown(),
});

export function conversationRoutes(
  svc: ReturnType<typeof import("./service.js").createConversationService>,
  idGen: () => string,
) {
  return {
    /** GET /api/conversations?agentId= → 200 [{ conversationId, members }] */
    list(req: Request): Response {
      const url = new URL(req.url);
      const agentId = url.searchParams.get("agentId");
      const conversations = agentId
        ? svc.port.listConversationsByAgent(agentId)
        : svc.port.listConversations();
      return json(conversations);
    },

    /** POST /api/conversations → 201 */
    async create(req: Request): Promise<Response> {
      const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      const conversationId = parsed.data.conversationId ?? idGen();
      const now = Date.now();

      // Create conversation
      svc.port.createConversation({
        conversationId,
        triggerMode: parsed.data.triggerMode ?? "mention",
        createdAt: now,
      });

      // Add members
      const members = parsed.data.members ?? [];
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
      return json({ conversationId, members: allMembers }, 201);
    },

    /** POST /api/conversations/:id/members → 200 */
    async addMember(req: Request, conversationId: string): Promise<Response> {
      const parsed = addMemberSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      const memberId = parsed.data.memberId ?? idGen();
      await svc.addMember({
        conversationId,
        memberId,
        kind: parsed.data.kind,
        agentId: parsed.data.agentId,
        userRef: parsed.data.userRef,
        displayName: parsed.data.displayName,
      });

      const members = svc.port.getMembers(conversationId);
      return json({ members });
    },

    /** DELETE member: POST with { memberId } body → 200 */
    async removeMember(req: Request, conversationId: string): Promise<Response> {
      const parsed = removeMemberSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      await svc.removeMember(conversationId, parsed.data.memberId);
      const members = svc.port.getMembers(conversationId);
      return json({ members });
    },

    /** POST /api/conversations/:id/messages → 202 { seq, triggeredRuns } */
    async postMessage(req: Request, conversationId: string): Promise<Response> {
      const parsed = messageSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      try {
        const result = await svc.postMessage({
          conversationId,
          senderMemberId: parsed.data.senderMemberId,
          addressedTo: parsed.data.addressedTo,
          content: parsed.data.content,
        });
        return json(result, 202);
      } catch (err) {
        if (err instanceof ConversationBusyError)
          return json({ error: (err as Error).message }, 409);
        throw err;
      }
    },

    /** DELETE /api/conversations/:id → 204 */
    delete(_req: Request, conversationId: string): Response {
      const deleted = svc.port.deleteConversation(conversationId);
      if (!deleted) return json({ error: "Not found" }, 404);
      return new Response(null, { status: 204 });
    },

    /** GET /api/conversations/:id → 200 { conversationId, triggerMode, members } */
    async snapshot(_req: Request, conversationId: string): Promise<Response> {
      const conv = svc.port.getConversation(conversationId);
      if (!conv) return json({ error: "Not found" }, 404);
      const members = svc.port.getMembers(conversationId);
      return json({
        conversationId: conv.conversationId,
        triggerMode: conv.triggerMode,
        hopCount: conv.hopCount,
        title: conv.title,
        members,
      });
    },

    /** GET /api/conversations/:id/events → SSE */
    async events(req: Request, conversationId: string): Promise<Response> {
      const qsAfterSeq = new URL(req.url).searchParams.get("afterSeq");
      const afterSeq = qsAfterSeq
        ? parseInt(qsAfterSeq, 10) || 0
        : parseInt(req.headers.get("Last-Event-ID") ?? "0", 10) || 0;

      const stream = svc.subscribeConversation(conversationId, {
        afterSeq,
        signal: req.signal,
      });

      return sseResponse(
        stream,
        (entry) => ({
          id: String(entry.seq),
          event: entry.kind,
          data: entry,
        }),
        req.signal,
      );
    },
  };
}
