import { Elysia, t } from "elysia";
import type { EntityLabelResolver } from "../../infra/entity-labels.js";
import { parseBoundedLimit, parseBoundedOffset } from "../../infra/http-utils.js";
import { describeAnchor, isArtifactAnchor } from "../artifact/anchor.js";
import { parseArtifactUrl } from "../artifact/domain.js";
import { renderRevision } from "./export-markdown.js";
import { senderLabelOf } from "./ledger-codec.js";
import type { ConversationService } from "./service.js";

export function conversationRoutes(
  svc: ConversationService,
  idGen: () => string,
  projectExists?: (id: string) => boolean,
  /** ADR 0049: role lookup for the creation guard (front desk invariant).
   * Absent = any agent may own a conversation (today's behaviour). */
  agentRoleOf?: (id: string) => Promise<"front" | "worker" | undefined>,
  /** ADR 0082: optional linkage filters & batch label resolver. */
  linkage?: {
    conversationIdsForRequirement?: (requirementId: string) => string[];
    labelResolver?: EntityLabelResolver;
  },
) {
  return (
    new Elysia()
      .get(
        "/api/conversations",
        ({ query: { agentId, requirementId, projectId, limit, offset } }) => {
          let conversations = agentId
            ? svc.port.listConversationsByAgent(agentId)
            : svc.port.listConversations();
          if (projectId) {
            conversations = conversations.filter((c) => c.projectId === projectId);
          }
          if (requirementId && linkage?.conversationIdsForRequirement) {
            const allowed = new Set(linkage.conversationIdsForRequirement(requirementId));
            conversations = conversations.filter((c) => allowed.has(c.conversationId));
          }
          if (limit !== undefined || offset !== undefined) {
            const lim = parseBoundedLimit(limit, 200, 500);
            const off = parseBoundedOffset(offset);
            conversations = conversations.slice(off, off + lim);
          }
          if (!linkage?.labelResolver || conversations.length === 0) return conversations;
          const maps = linkage.labelResolver.resolveBatch({
            agentIds: conversations.map((c) => c.agentId),
            projectIds: conversations.map((c) => c.projectId),
            requirementIds: conversations.map(
              (c) => (c as { currentRequirementId?: string | null }).currentRequirementId,
            ),
          });
          return conversations.map((c) => {
            const reqId = (c as { currentRequirementId?: string | null }).currentRequirementId;
            const labels = linkage.labelResolver!.labelsFor(
              { agentId: c.agentId, projectId: c.projectId, requirementId: reqId },
              maps,
            );
            return labels ? { ...c, labels } : c;
          });
        },
        {
          query: t.Object({
            agentId: t.Optional(t.String()),
            requirementId: t.Optional(t.String()),
            projectId: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/api/conversations",
        async ({ body, set }) => {
          const conversationId = body.conversationId ?? idGen();
          const now = Date.now();
          if (body.projectId && projectExists && !projectExists(body.projectId)) {
            return Response.json({ error: `unknown project ${body.projectId}` }, { status: 400 });
          }
          // ADR 0049 (amended 2026-11-23): a worker-owned room is a DIRECT
          // LINE — the person decided to skip the front desk, so the room is
          // not a dead one and the request is honoured. Without the explicit
          // flag the old rule stands: a plain binding would read as "a room
          // where nobody answers", because unmarked rooms route to the front.
          const targetAgent = body.agentId ?? "default";
          if (
            body.direct !== true &&
            agentRoleOf &&
            (await agentRoleOf(targetAgent)) === "worker"
          ) {
            return Response.json(
              {
                error: `agent ${targetAgent} is a worker: humans talk to a front agent, work reaches workers via dispatch (pass direct:true to open a direct line)`,
              },
              { status: 400 },
            );
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
            /** ADR 0049 amendment: an explicit direct line to a worker. */
            direct: t.Optional(t.Boolean()),
            /** Conversation provenance: user | workflow | fork. Workflow-
             *  scoped chats are excluded from the user's chat surfaces. */
            origin: t.Optional(t.String({ minLength: 1 })),
          }),
        },
      )
      .get(
        "/api/conversations/search",
        ({ query }) => {
          const results = svc.port.searchLedger(query.q, parseBoundedLimit(query.limit, 20, 200));
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
        const currentRequirementId =
          (conv as { currentRequirementId?: string | null }).currentRequirementId ?? null;
        const labels = linkage?.labelResolver?.labelsFor({
          agentId: conv.agentId,
          projectId: conv.projectId,
          requirementId: currentRequirementId,
        });
        return {
          conversationId: conv.conversationId,
          agentId: conv.agentId,
          origin: conv.origin,
          hopCount: conv.hopCount,
          title: conv.title,
          createdAt: conv.createdAt,
          forkSource: conv.forkSource,
          projectId: conv.projectId,
          currentRequirementId,
          forkFromSeq: conv.forkFromSeq,
          // ADR 0070: a child room names the room that dispatched into it, so
          // its page can offer the way back.
          parentConversationId: conv.parentConversationId,
          lastActivityAt: svc.port.getLastActivityAt?.(id) ?? null,
          lastMessagePreview: svc.port.getLastMessagePreview?.(id) ?? null,
          lastSeq: svc.port.getLastSeq?.(id) ?? null,
          ...(labels ? { labels } : {}),
        };
      })
      .post(
        "/api/conversations/:id/artifact-comments",
        async ({ params: { id }, body, set }) => {
          let ref: ReturnType<typeof parseArtifactUrl>;
          try {
            ref = parseArtifactUrl(body.url);
          } catch {
            set.status = 400;
            return { error: "malformed artifact url" };
          }
          if (!isArtifactAnchor(body.anchor)) {
            set.status = 400;
            return { error: "invalid anchor" };
          }
          const result = await svc.postMessage({
            conversationId: id,
            content: `[${describeAnchor(ref.filename, body.anchor)}] ${body.text}`,
            anchor: { url: body.url, anchor: body.anchor },
          });
          set.status = 202;
          return result;
        },
        {
          body: t.Object({
            url: t.String({ minLength: 1 }),
            anchor: t.Unknown(),
            text: t.String({ minLength: 1 }),
          }),
        },
      )
      .post(
        "/api/conversations/:id/messages/:seq/saved",
        ({ params: { id, seq }, body, set }) => {
          const seqNum = Number(seq);
          if (!Number.isInteger(seqNum) || seqNum < 1) {
            set.status = 400;
            return { error: "invalid message seq" };
          }
          if (!svc.port.setSaved(seqNum, body.saved, id)) {
            set.status = 404;
            return { error: "no such ledger row" };
          }
          return { seq: seqNum, saved: body.saved };
        },
        {
          body: t.Object({ saved: t.Boolean() }),
        },
      )
      .get("/api/saved", () => ({ saved: svc.port.listSaved() }))
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
            trigger: body.trigger,
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
            /** False = ledger-only note (no agent run triggered). Default true. */
            trigger: t.Optional(t.Boolean()),
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
      .get("/api/conversations/:id/inputs/:inputId", async ({ params: { id, inputId } }) => {
        const input = await svc.getInputState(inputId, id);
        if (!input) return Response.json({ error: "Input not found" }, { status: 404 });
        return input;
      })
      .post(
        "/api/conversations/:id/inputs/:inputId/steer",
        async ({ params: { id, inputId }, body }) => {
          try {
            await svc.steerInput(inputId, {
              conversationId: id,
              ...(body?.keepIfIdle ? { keepIfIdle: true } : {}),
            });
            return { ok: true };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === "Input not found") return Response.json({ error: msg }, { status: 404 });
            return Response.json({ error: msg }, { status: 409 });
          }
        },
        {
          // #64: a queued input steered from its Lark card. keepIfIdle=true means
          // "if the turn already ended, leave it queued for the next turn" — the
          // direct steer path (default) keeps its cancel-on-idle semantics.
          body: t.Optional(t.Object({ keepIfIdle: t.Optional(t.Boolean()) })),
        },
      )
      .patch(
        "/api/conversations/:id/inputs/:inputId",
        async ({ params: { id, inputId }, body }) => {
          const updated = await svc.updateInput(inputId, body.text, id);
          if (!updated)
            return Response.json({ error: "Input is no longer pending" }, { status: 409 });
          return { ok: true };
        },
        { body: t.Object({ text: t.String({ minLength: 1 }) }) },
      )
      .post(
        "/api/conversations/:id/inputs/:inputId/cancel",
        async ({ params: { id, inputId } }) => {
          await svc.cancelInput(inputId, id);
          return { ok: true };
        },
      )
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
            text = renderRevision(parsed);
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
        { body: t.Object({ count: t.Optional(t.Integer({ minimum: 1 })) }) },
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
          }),
        },
      )
  );
}
