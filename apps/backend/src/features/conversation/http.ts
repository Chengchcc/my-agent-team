import { extractText } from "@chengchenccc/message";
import { Elysia, t } from "elysia";
import { senderLabelOf } from "./ledger-codec.js";
import type { ConversationService } from "./service.js";

export function conversationRoutes(
  svc: ConversationService,
  idGen: () => string,
  projectExists?: (id: string) => boolean,
  /** ADR 0041 member management; absent = routes 404/empty-list degrade. */
  members?: {
    list(conversationId: string): string[];
    add(conversationId: string, agentId: string): Promise<boolean> | boolean;
    remove(conversationId: string, agentId: string): boolean;
  },
) {
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
          if (body.projectId && projectExists && !projectExists(body.projectId)) {
            return Response.json({ error: `unknown project ${body.projectId}` }, { status: 400 });
          }
          // Idempotent create: workflow-scoped chats (and any caller that
          // passes a stable conversationId) may POST on every reload when the
          // conversation already exists. Return it instead of crashing the
          // insert with a UNIQUE violation.
          const existing = svc.port.getConversation(conversationId);
          if (existing) {
            set.status = 200;
            return { conversationId, agentId: existing.agentId ?? body.agentId ?? "default" };
          }
          svc.port.createConversation({
            conversationId,
            agentId: body.agentId,
            createdAt: now,
            projectId: body.projectId ?? null,
            origin: body.origin ?? "user",
          });
          set.status = 201;
          return { conversationId, agentId: body.agentId };
        },
        {
          body: t.Object({
            conversationId: t.Optional(t.String({ minLength: 1 })),
            projectId: t.Optional(t.String({ minLength: 1 })),
            agentId: t.Optional(t.String({ minLength: 1 })),
            /** Conversation provenance: user | workflow | fork. Workflow-
             *  scoped chats are excluded from the user's chat surfaces. */
            origin: t.Optional(t.String({ minLength: 1 })),
          }),
        },
      )
      .get(
        "/api/conversations/search",
        ({ query }) => {
          const results = svc.port.searchLedger(query.q, query.limit ? Number(query.limit) : 20);
          return { results };
        },
        {
          query: t.Object({
            q: t.String({ minLength: 1 }),
            limit: t.Optional(t.String()),
          }),
        },
      )
      .get("/api/conversations/:id", ({ params: { id } }) => {
        const conv = svc.port.getConversation(id);
        if (!conv) return Response.json({ error: "Not found" }, { status: 404 });
        return {
          conversationId: conv.conversationId,
          agentId: conv.agentId,
          origin: conv.origin,
          hopCount: conv.hopCount,
          title: conv.title,
          createdAt: conv.createdAt,
          forkSource: conv.forkSource,
          projectId: conv.projectId,
          forkFromSeq: conv.forkFromSeq,
          lastActivityAt: svc.port.getLastActivityAt?.(id) ?? null,
          lastMessagePreview: svc.port.getLastMessagePreview?.(id) ?? null,
          lastSeq: svc.port.getLastSeq?.(id) ?? null,
        };
      })
      .get("/api/conversations/:id/members", ({ params: { id } }) => ({
        members: members?.list(id) ?? [],
      }))
      .post(
        "/api/conversations/:id/members",
        async ({ params: { id }, body, set }) => {
          try {
            const added = await members?.add(id, body.agentId);
            set.status = added ? 201 : 200;
            return { members: members?.list(id) ?? [] };
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : "cannot add member" },
              { status: 400 },
            );
          }
        },
        { body: t.Object({ agentId: t.String({ minLength: 1 }) }) },
      )
      .delete("/api/conversations/:id/members/:agentId", async ({ params, set }) => {
        try {
          const removed = members?.remove(params.id, params.agentId) ?? false;
          if (!removed) {
            set.status = 404;
            return { error: "not a member" };
          }
          set.status = 200;
          return { members: members?.list(params.id) ?? [] };
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "cannot remove member" },
            { status: 400 },
          );
        }
      })
      .delete("/api/conversations/:id", async ({ params: { id }, set }) => {
        const deleted = await svc.port.deleteConversation(id);
        if (!deleted) return Response.json({ error: "Not found" }, { status: 404 });
        set.status = 204;
        return "";
      })
      .post(
        "/api/conversations/:id/messages",
        async ({ params: { id: conversationId }, body, set }) => {
          const result = await svc.postMessage({
            conversationId,
            senderMemberId: body.senderMemberId,
            addressedTo: body.addressedTo,
            content: body.content,
            mode: body.mode,
            modelOverride: body.model,
          });
          set.status = 202;
          return result;
        },
        {
          body: t.Object({
            senderMemberId: t.Optional(t.String({ minLength: 1 })),
            addressedTo: t.Optional(t.Array(t.String())),
            // The only two shapes the writer understands (service.postMessage):
            // a plain string, or ContentBlock[] for attachments. `t.Any()`
            // used to stand here, which silently accepted anything — and since
            // this schema is the wire type every caller shares through Eden
            // Treaty, `any` also switched OFF the compile-time check that would
            // have caught the Lark bot posting `{ text, source, ... }`: the
            // request validated, the writer matched neither branch, and the
            // user's message was stored with no text at all. A message that
            // arrives with text and is stored without it is the worst failure
            // shape there is, so the shape is now stated.
            content: t.Union([t.String(), t.Array(t.Record(t.String(), t.Any()))]),
            mode: t.Optional(
              t.Union([t.Literal("normal"), t.Literal("steer"), t.Literal("follow_up")]),
            ),
            model: t.Optional(
              t.Object({
                backendKind: t.String(),
                modelId: t.String(),
                // The ACP kind names its harness in modelId and runs what this
                // names (BackendModelRef.harnessModel). Validated here because
                // t.Object silently drops what it does not declare - the
                // caller would think it chose a model and the run would use the
                // harness default.
                harnessModel: t.Optional(t.String({ minLength: 1 })),
                reasoningEffort: t.Optional(
                  t.Union([
                    t.Literal("none"),
                    t.Literal("low"),
                    t.Literal("high"),
                    t.Literal("max"),
                  ]),
                ),
              }),
            ),
          }),
        },
      )
      // ── Pending input queue (Composer queue area) ──
      .get("/api/conversations/:id/inputs", async ({ params: { id: conversationId } }) => {
        const inputs = await svc.listPendingInputs(conversationId);
        return { inputs };
      })
      .get("/api/conversations/:id/inputs/:inputId", async ({ params: { inputId } }) => {
        const input = await svc.getInputState(inputId);
        if (!input) return Response.json({ error: "Input not found" }, { status: 404 });
        return input;
      })
      .post("/api/conversations/:id/inputs/:inputId/steer", async ({ params: { inputId } }) => {
        try {
          await svc.steerInput(inputId);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "Input not found") return Response.json({ error: msg }, { status: 404 });
          return Response.json({ error: msg }, { status: 409 });
        }
      })
      .patch(
        "/api/conversations/:id/inputs/:inputId",
        async ({ params: { inputId }, body }) => {
          const updated = await svc.updateInput(inputId, body.text);
          if (!updated)
            return Response.json({ error: "Input is no longer pending" }, { status: 409 });
          return { ok: true };
        },
        { body: t.Object({ text: t.String({ minLength: 1 }) }) },
      )
      .post("/api/conversations/:id/inputs/:inputId/cancel", async ({ params: { inputId } }) => {
        await svc.cancelInput(inputId);
        return { ok: true };
      })
      .post("/api/conversations/:id/clear", async ({ params: { id } }) => {
        await svc.clearConversation(id);
        return { ok: true };
      })
      .post("/api/conversations/:id/compact", async ({ params: { id } }) => {
        await svc.compactConversation(id);
        return { ok: true };
      })
      .patch(
        "/api/conversations/:id",
        async ({ params: { id }, body }) => {
          if (body.title !== undefined) {
            svc.port.setConversationTitle(id, body.title);
          }
          return { ok: true };
        },
        {
          body: t.Object({ title: t.Optional(t.String()) }),
        },
      )
      .get("/api/conversations/:id/export", async ({ params: { id } }) => {
        const entries = svc.port.getLedgerEntries(id);
        const conv = svc.port.getConversation(id);
        const title = conv?.title || id;
        const lines: string[] = [`# ${title}`, ""];
        for (const e of entries) {
          if (e.kind !== "message") continue;
          const ts = new Date(e.ts).toISOString();
          const sender = senderLabelOf(e.content);
          let text: string;
          try {
            // Drizzle's select schema auto-parses content from JSON string to object.
            const parsed = typeof e.content === "string" ? JSON.parse(e.content) : e.content;
            text =
              typeof parsed === "string" ? parsed : extractText(parsed) || JSON.stringify(parsed);
          } catch {
            text = String(e.content);
          }
          lines.push(`## ${ts}`, `**${sender}**: ${text}`, "");
        }
        const md = lines.join("\n");
        return new Response(md, { headers: { "content-type": "text/markdown" } });
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
          }),
        },
      )
      // ── Fork / Undo / Replay ──
      .post(
        "/api/conversations/:id/fork",
        async ({ params: { id }, body, set }) => {
          const result = await svc.forkConversation({ conversationId: id, ...body });
          set.status = 201;
          return result;
        },
        { body: t.Object({ fromSeq: t.Number(), title: t.Optional(t.String()) }) },
      )
      .post(
        "/api/conversations/:id/undo",
        async ({ params: { id }, body }) => {
          return await svc.undoMessages({ conversationId: id, ...body });
        },
        { body: t.Object({ count: t.Optional(t.Number()) }) },
      )
      .post(
        "/api/conversations/:id/replay",
        async ({ params: { id }, body, set }) => {
          const result = await svc.replayFromMessage({ conversationId: id, ...body });
          set.status = 201;
          return result;
        },
        {
          body: t.Object({
            fromSeq: t.Number(),
            editedContent: t.String(),
            senderMemberId: t.Optional(t.String()),
            addressedTo: t.Optional(t.Array(t.String())),
          }),
        },
      )
  );
}
