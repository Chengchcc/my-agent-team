import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import type { Message, MessageRevision } from "@my-agent-team/message";
import {
  deserializeLedgerContent,
  extractText,
  isTerminalMessageState,
} from "@my-agent-team/message";
import {
  ConversationCtx,
  conversationContextPlugin,
} from "@my-agent-team/plugin-conversation-context";
import type { BackendConfig } from "../../config.js";
import { ulid } from "../../infra/ids.js";
import type { AgentService } from "../agent/index.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import {
  convTools,
  createModel,
  defaultContextManager,
  defaultPlugins,
  defaultTools,
} from "../span/agent-helpers.js";
import type { SessionManager } from "../span/session-manager.js";
import type { SpanSupervisor } from "../span/supervisor.js";
import { sqliteConversationAdapter } from "./index.js";
import { ConversationLock } from "./lock.js";
import type { ConversationPort } from "./ports.js";
import { escapeRegExp, getOrCreateAccumulator } from "./run-accumulator.js";
import { createConversationService } from "./service.js";
import { buildTitleContext, generateTitle } from "./title.js";

export interface ConversationFeature {
  convPort: ConversationPort;
  convSvc: ReturnType<typeof createConversationService>;
  lock: ConversationLock;
}

const titlingInFlight = new Set<string>();

export function createConversationFeature(
  db: Database,
  config: BackendConfig,
  _supervisor: SpanSupervisor,
  agentSvc: AgentService,
  opsStore: RuntimeOpsStore,
  sessionManager: SessionManager,
  lock: ConversationLock = new ConversationLock(),
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

  // Auto-title: fire-and-forget on first terminal response
  const autoTitle = async (cid: string) => {
    const model = new AnthropicChatModel({
      apiKey: config.anthropicApiKey,
      baseUrl: config.anthropicBaseUrl,
      model: "claude",
    });
    const entries = convPort.getLedgerEntries(cid).filter((e) => e.kind === "message");
    const msgs: Message[] = entries.slice(0, 6).map((e) => {
      const result = deserializeLedgerContent(e.content);
      if (!("messageId" in result)) {
        return { role: "user" as const, text: "" };
      }
      return {
        role: (result.role as Message["role"]) ?? "user",
        text: extractText({
          text: result.text ?? "",
          blocks: result.blocks ?? [],
        }),
      };
    });
    const ctx = buildTitleContext(msgs);
    const title = await generateTitle(() => model, ctx);
    if (title) convPort.setConversationTitle(cid, title);
  };

  // Message handling — writes to ledger, scans @mentions, broadcasts SSE
  const handleAssistantMessage = async (
    conversationId: string,
    agentMemberId: string,
    spanId: string,
    rev: MessageRevision,
  ) => {
    await convSvc.appendAssistantMessage({
      conversationId,
      senderMemberId: agentMemberId,
      spanId,
      revision: rev,
    });

    const acc = getOrCreateAccumulator(spanId, agentMemberId);
    if (rev.role === "assistant") {
      acc.latestAssistantRevision = { ...rev, conversationId };
      if (isTerminalMessageState(rev.state)) {
        // Auto-title: generate on first terminal response if no title yet
        const conv = convPort.getConversation(conversationId);
        if (conv && !conv.title && !titlingInFlight.has(conversationId)) {
          titlingInFlight.add(conversationId);
          void autoTitle(conversationId)
            .catch(() => {
              /* best-effort */
            })
            .finally(() => titlingInFlight.delete(conversationId));
        }
        const text = extractText(rev);
        if (text) {
          const roster = convPort.getMembers(conversationId);
          for (const m of roster) {
            if (m.kind !== "agent" || m.memberId === agentMemberId) continue;
            const label = m.displayName ?? m.memberId;
            if (getMentionRe(label).test(text) || text.includes(`@${m.memberId}`)) {
              acc.mentionedMemberIds.add(m.memberId);
            }
          }
        }
      }
    }
  };

  const convSvc = createConversationService({
    port: convPort,
    lock,
    maxConsecutiveAgentHops: 8,
    idGen: ulid,

    startAgentRun: async (spanId, ctx) => {
      const { conversationId, agentMemberId, agentId, input } = ctx;
      const members = convPort.getMembers(conversationId);
      const isLark = members.some((m) => m.kind === "human" && m.userRef?.startsWith("lark:"));
      const surface = isLark ? "lark" : "web";

      const { modelName } = await agentSvc.getById(agentId);
      const cwd = join(config.dataDir, "agents", agentId);
      const cTools = convTools(convPort, conversationId);
      const agentConfig = {
        model: createModel(modelName, config),
        tools: [...defaultTools(cwd), ...cTools],
        plugins: [...defaultPlugins(cwd, config), conversationContextPlugin({ tools: cTools })],
        contextManager: defaultContextManager(),
      };
      const existingSid = convPort.getMemberSessionId(conversationId, agentMemberId);
      const session = existingSid
        ? sessionManager.open(existingSid, agentConfig)
        : sessionManager.create(agentConfig);
      if (!existingSid) {
        convPort.updateMemberSessionId(conversationId, agentMemberId, session.sessionId ?? "");
      }

      // Business event subscription
      session.subscribe((event) => {
        if (event.type === "message_update" || event.type === "message") {
          const rev = event.payload as MessageRevision;
          void handleAssistantMessage(conversationId, agentMemberId, rev.spanId ?? spanId, rev);
        }
        if (event.type === "todo_update") {
          const acc = getOrCreateAccumulator(event.spanId ?? spanId, agentMemberId);
          acc.lastTodoUpdate = {
            todos: (event as { payload: { todos: Array<{ step: string; status: string }> } })
              .payload.todos,
          };
        }
      });
      // Execute — origin via prompt opts, context via setContext
      session.setContext(ConversationCtx, {
        id: conversationId,
        surface,
        senderName: agentMemberId,
        input: input ?? "",
      });
      void session.prompt(input ?? "", {
        spanId,
        origin: { conversationId, agentMemberId: agentId, surface, originKind: "manual" },
      });

      return { spanId, attemptSeq: 0 };
    },

    verifyRunOwnsConversation: async (spanId, conversationId) => {
      const origin = opsStore.getSpanOrigin(spanId);
      if (!origin) throw new Error(`run not found: ${spanId}`);
      if (origin.conversationId !== conversationId) {
        throw new Error(`run ${spanId} does not belong to conversation ${conversationId}`);
      }
    },
  });

  return { convPort, convSvc, lock };
}
