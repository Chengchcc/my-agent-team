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
import { executeAgentRun, makeRunDeps } from "../run/run-executor.js";
import type { RunSupervisor } from "../run/supervisor.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import { sqliteConversationAdapter } from "./index.js";
import { ConversationLock } from "./lock.js";
import type { ConversationPort } from "./ports.js";
import { escapeRegExp, getOrCreateAccumulator } from "./projection.js";
import { createConversationService, parseThreadId } from "./service.js";

export interface ConversationFeature {
  convPort: ConversationPort;
  convSvc: ReturnType<typeof createConversationService>;
  lock: ConversationLock;
}

export function createConversationFeature(
  db: Database,
  _config: BackendConfig,
  supervisor: RunSupervisor,
  agentSvc: AgentService,
  _opsStore: RuntimeOpsStore,
): ConversationFeature {
  const convPort = sqliteConversationAdapter(db);
  const lock = new ConversationLock();

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
  const handleAssistantMessage = async (threadId: string, runId: string, rev: MessageRevision) => {
    const cid = parseThreadId(threadId).conversationId;
    if (!cid) return;
    const sender = parseThreadId(threadId).memberId || threadId;

    await convSvc.appendAssistantMessage({
      conversationId: cid,
      senderMemberId: sender,
      runId,
      revision: rev,
    });

    const acc = getOrCreateAccumulator(runId, sender);
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
      content: serializeMessageRevision({ ...rev, conversationId: cid, runId }),
      ts: Date.now(),
    };
    void convSvc.broadcastMessage(entry, { excludeMemberId: sender }).catch(() => {});
  };

  const convSvc = createConversationService({
    port: convPort,
    lock,
    maxConsecutiveAgentHops: 8,
    idGen: ulid,

    startAgentRun: async (_runId, threadId, ctx) => {
      const members = convPort.getMembers(ctx.conversationId);
      const isLark = members.some((m) => m.kind === "human" && m.userRef?.startsWith("lark:"));
      const runDeps = makeRunDeps({
        config: _config,
        supervisor,
        opsStore: _opsStore,
        agentSvc,
        convPort,
      });
      return executeAgentRun(runDeps, {
        runId: crypto.randomUUID(),
        sessionId: threadId,
        agentId: ctx.agentId,
        input: "",
        origin: {
          kind: "conversation",
          conversationId: ctx.conversationId,
          surface: isLark ? "lark" : "web",
          senderName: ctx.agentMemberId,
        },
        onAssistantMessage: (payload) => {
          const rev = payload as unknown as MessageRevision;
          void handleAssistantMessage(threadId, rev.runId ?? _runId, rev);
        },
      });
    },

    verifyRunOwnsConversation: async (runId, conversationId) => {
      const runDb = supervisor.getDb();
      const row = runDb.query("SELECT session_id FROM run WHERE run_id = ?").get(runId) as
        | { session_id: string }
        | undefined;
      if (!row) throw new Error(`run not found: ${runId}`);
      if (!row.session_id.startsWith(`${conversationId}:`)) {
        throw new Error(`run ${runId} does not belong to conversation ${conversationId}`);
      }
    },
  });

  return { convPort, convSvc, lock };
}

// ─── startAgentRun (thin wrapper around executeAgentRun) ──

export interface StartAgentRunOpts {
  threadId: string;
  agentId: string;
  input: string;
  config: BackendConfig;
  agentSvc: AgentService;
  convPort: ConversationPort;
  conversationId: string;
  supervisor: RunSupervisor;
  opsStore: RuntimeOpsStore;
  surface?: string;
  senderName?: string;
  onAssistantMessage?: (revision: Record<string, unknown>) => void;
  onComplete?: (runId: string, status: string) => void;
}

export async function startAgentRun(
  opts: StartAgentRunOpts,
): Promise<{ runId: string; attemptSeq: number }> {
  const runDeps = makeRunDeps({
    config: opts.config,
    supervisor: opts.supervisor,
    opsStore: opts.opsStore,
    agentSvc: opts.agentSvc,
    convPort: opts.convPort,
  });
  return executeAgentRun(runDeps, {
    runId: crypto.randomUUID(),
    sessionId: opts.threadId,
    agentId: opts.agentId,
    input: opts.input,
    origin: {
      kind: "conversation",
      conversationId: opts.conversationId,
      surface: opts.surface ?? "web",
      senderName: opts.senderName ?? "unknown",
    },
    onAssistantMessage: opts.onAssistantMessage,
    onComplete: opts.onComplete,
  });
}
