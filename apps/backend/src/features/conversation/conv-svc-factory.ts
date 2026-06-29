import type { Database } from "bun:sqlite";
import type { MessageRevision } from "@my-agent-team/message";
import {
  extractText,
  isTerminalMessageState,
  serializeMessageRevision,
} from "@my-agent-team/message";
import type { BackendConfig } from "../../config.js";
import { ulid } from "../../infra/ids.js";
import type { AgentService } from "../agent/index.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import type { SessionFactory } from "../span/session-factory.js";
import { executeAgentRun, makeRunDeps } from "../span/span-executor.js";
import type { SpanSupervisor } from "../span/supervisor.js";
import { sqliteConversationAdapter } from "./index.js";
import { ConversationLock } from "./lock.js";
import type { ConversationPort } from "./ports.js";
import { escapeRegExp, getOrCreateAccumulator } from "./projection.js";
import { createConversationService, parseSessionId } from "./service.js";

export interface ConversationFeature {
  convPort: ConversationPort;
  convSvc: ReturnType<typeof createConversationService>;
  lock: ConversationLock;
}

export function createConversationFeature(
  db: Database,
  _config: BackendConfig,
  supervisor: SpanSupervisor,
  agentSvc: AgentService,
  opsStore: RuntimeOpsStore,
  lock: ConversationLock = new ConversationLock(),
  _sessionFactory?: SessionFactory,
): ConversationFeature {
  const convPort = sqliteConversationAdapter(db);

  // @mention regex cache
  const mentionCache = new Map<string, RegExp>();
  const getMentionRe = (label: string) => {
    let re = mentionCache.get(label);
    if (!re) {
      re = new RegExp(`@${escapeRegExp(label)}(?=\\s|[,.!?;:]|$)`, "g");
      mentionCache.set(label, re);
    }
    return re;
  };

  // Message handling — writes to ledger, scans @mentions, broadcasts SSE
  const handleAssistantMessage = async (
    sessionId: string,
    spanId: string,
    rev: MessageRevision,
  ) => {
    const cid = parseSessionId(sessionId).conversationId;
    if (!cid) return;
    const sender = parseSessionId(sessionId).memberId || sessionId;

    await convSvc.appendAssistantMessage({
      conversationId: cid,
      senderMemberId: sender,
      spanId,
      revision: rev,
    });

    const acc = getOrCreateAccumulator(spanId, sender);
    if (rev.role === "assistant") {
      acc.latestAssistantRevision = { ...rev, conversationId: cid };
      if (isTerminalMessageState(rev.state)) {
        const text = extractText(rev);
        if (text) {
          const roster = convPort.getMembers(cid);
          for (const m of roster) {
            if (m.kind !== "agent" || m.memberId === sender) continue;
            const label = m.displayName ?? m.memberId;
            if (getMentionRe(label).test(text) || text.includes(`@${m.memberId}`)) {
              acc.mentionedMemberIds.add(m.memberId);
            }
          }
        }
      }
    }

    const entry = {
      seq: 0,
      conversationId: cid,
      senderMemberId: sender,
      addressedTo: [] as string[],
      kind: "message" as const,
      content: serializeMessageRevision({ ...rev, conversationId: cid, spanId }),
      ts: Date.now(),
    };
    void convSvc.broadcastMessage(entry, { excludeMemberId: sender }).catch(() => {});
  };

  const convSvc = createConversationService({
    port: convPort,
    lock,
    maxConsecutiveAgentHops: 8,
    idGen: ulid,

    startAgentRun: async (_runId, sessionId, ctx) => {
      const members = convPort.getMembers(ctx.conversationId);
      const isLark = members.some((m) => m.kind === "human" && m.userRef?.startsWith("lark:"));
      const runDeps = makeRunDeps({
        config: _config,
        supervisor,
        opsStore,
        agentSvc,
        convPort,
        sessionFactory: _sessionFactory,
      });
      const spanId = crypto.randomUUID();
      return executeAgentRun(runDeps, {
        spanId,
        sessionId: sessionId,
        agentId: ctx.agentId,
        input: ctx.input ?? "",
        origin: {
          kind: "conversation",
          conversationId: ctx.conversationId,
          surface: isLark ? "lark" : "web",
          senderName: ctx.agentMemberId,
        },
        onAssistantMessageUpdate: (payload) => {
          const rev = payload as unknown as MessageRevision;
          const cid = parseSessionId(sessionId).conversationId;
          if (!cid) return;
          const entry = {
            seq: -1, // streaming — not persisted
            conversationId: cid,
            senderMemberId: parseSessionId(sessionId).memberId || sessionId,
            addressedTo: [] as string[],
            kind: "message" as const,
            content: serializeMessageRevision({
              ...rev,
              conversationId: cid,
              spanId: rev.spanId ?? spanId,
            }),
            ts: Date.now(),
          };
          convSvc.pushSseEvent(cid, entry);
        },
        onAssistantMessage: (payload) => {
          const rev = payload as unknown as MessageRevision;
          void handleAssistantMessage(sessionId, rev.spanId ?? spanId, rev);
        },
        onTodoUpdate: (todos) => {
          // lastTodoUpdate is consumed by onRunComplete Phase 3 appendTodo
          const senderMemberId = parseSessionId(sessionId).memberId || sessionId;
          const acc = getOrCreateAccumulator(spanId, senderMemberId);
          acc.lastTodoUpdate = { todos };
        },
      });
    },

    verifyRunOwnsConversation: async (spanId, conversationId) => {
      const sessionId = opsStore.getSessionIdBySpanId(spanId);
      if (!sessionId) throw new Error(`run not found: ${spanId}`);
      if (!sessionId.startsWith(`${conversationId}:`)) {
        throw new Error(`run ${spanId} does not belong to conversation ${conversationId}`);
      }
    },
  });

  return { convPort, convSvc, lock };
}
