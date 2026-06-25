import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import {
  autoSummarize,
  pipeContextManagers,
  sqliteCheckpointer,
  toolResultTruncator,
} from "@my-agent-team/framework";
import { AgentSession } from "@my-agent-team/harness";
import type { MessageRevision } from "@my-agent-team/message";
import {
  extractText,
  isTerminalMessageState,
  serializeMessageRevision,
} from "@my-agent-team/message";
import { conversationContextPlugin } from "@my-agent-team/plugin-conversation-context";
import { fsMemoryPlugin } from "@my-agent-team/plugin-fs-memory";
import { identityPlugin } from "@my-agent-team/plugin-identity";
import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import {
  bashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  globTool,
  grepTool,
} from "@my-agent-team/tools-common";
import type { BackendConfig } from "../../config.js";
import { ulid } from "../../infra/ids.js";
import type { AgentService } from "../agent/index.js";
import { registerSession, removeSession } from "../run/session-registry.js";
import type { RunSupervisor } from "../run/supervisor.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import {
  createListMembersTool,
  createReadContextTool,
  createReadHistoryTool,
  createSearchTool,
} from "./conv-tools.js";
import { sqliteConversationAdapter } from "./index.js";
import { ConversationLock } from "./lock.js";
import type { ConversationPort } from "./ports.js";
import {
  clearAccumulator,
  escapeRegExp,
  getOrCreateAccumulator,
  onRunComplete as runOnRunComplete,
} from "./projection.js";
import { createConversationService, parseThreadId } from "./service.js";

export interface ConversationFeature {
  convPort: ConversationPort;
  convSvc: ReturnType<typeof createConversationService>;
  /** M17.5 P4+P11: ConversationLock replaces ad-hoc activeConversations Set + threads Set. */
  lock: ConversationLock;
}

/** Create the full conversation feature — adapters, projection, and service.
 *  Encapsulates all the wiring between ledger, thread projection, and the
 *  forkRun closure that ties conversation events to agent runs. */
export function createConversationFeature(
  db: Database,
  _config: BackendConfig,
  supervisor: RunSupervisor,
  agentSvc: AgentService,
  _opsStore: RuntimeOpsStore,
): ConversationFeature {
  const convPort = sqliteConversationAdapter(db);
  const lock = new ConversationLock();

  // @mention regex cache (same pattern as main.ts)
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

    // Write to ledger (authoritative entry)
    await convSvc.appendAssistantMessage({
      conversationId: cid,
      senderMemberId: sender,
      runId,
      revision: rev,
    });

    // Update accumulator for @mention scanning
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

    // Broadcast to frontend (best-effort)
    const entry = {
      seq: 0, // appendAssistantMessage already wrote; broadcastMessage gets seq from ledger
      conversationId: cid,
      senderMemberId: sender,
      addressedTo: [] as string[],
      kind: "message" as const,
      content: serializeMessageRevision({ ...rev, conversationId: cid, runId }),
      ts: Date.now(),
    };
    void convSvc.broadcastMessage(entry, { excludeMemberId: sender }).catch(() => {});
  };

  // Completion handler — terminal revision + lock release + @mention triggers
  const handleRunComplete = async (threadId: string, runId: string, status: string) => {
    const cid = parseThreadId(threadId).conversationId;
    if (!cid) return;
    await runOnRunComplete(threadId, runId, status, convPort, convSvc, _opsStore, "main");
    clearAccumulator(runId);
  };

  const convSvc = createConversationService({
    port: convPort,
    lock,
    maxConsecutiveAgentHops: 8,
    idGen: ulid,

    startAgentRun: async (_runId, threadId, ctx) => {
      const members = convPort.getMembers(ctx.conversationId);
      const isLark = members.some((m) => m.kind === "human" && m.userRef?.startsWith("lark:"));
      return startAgentRun({
        threadId,
        agentId: ctx.agentId,
        input: "", // agent reads trigger from conversation context
        config: _config,
        agentSvc,
        convPort,
        conversationId: ctx.conversationId,
        supervisor,
        opsStore: _opsStore,
        surface: isLark ? "lark" : "web",
        senderName: ctx.agentMemberId,
        onAssistantMessage: (payload) => {
          const rev = payload as unknown as MessageRevision;
          void handleAssistantMessage(threadId, rev.runId ?? _runId, rev);
        },
        onComplete: (runId, status) => {
          void handleRunComplete(threadId, runId, status);
        },
      });
    },

    verifyRunOwnsConversation: async (runId, conversationId) => {
      const runDb = supervisor.getDb();
      const row = runDb.query("SELECT thread_id FROM run WHERE run_id = ?").get(runId) as
        | { thread_id: string }
        | undefined;
      if (!row) throw new Error(`run not found: ${runId}`);
      if (!row.thread_id.startsWith(`${conversationId}:`)) {
        throw new Error(`run ${runId} does not belong to conversation ${conversationId}`);
      }
    },
  });

  return { convPort, convSvc, lock };
}

// ─── startAgentRun (Phase 2: AgentSession integration) ──────

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
  /** Called with each assistant message revision to write to ledger + SSE. */
  onAssistantMessage?: (revision: Record<string, unknown>) => void;
  /** Called when run completes. */
  onComplete?: (runId: string, status: string) => void;
}

/**
 * Create an AgentSession and run it to completion.
 * Creates run/attempt rows via supervisor and returns tracking info.
 *
 * Replaces the old forkRun → dispatcher → supervisor → daemon chain
 * with direct in-process AgentSession execution.
 */
export async function startAgentRun(
  opts: StartAgentRunOpts,
): Promise<{ runId: string; attemptId: string }> {
  const {
    threadId,
    agentId,
    input,
    config,
    agentSvc,
    convPort,
    conversationId,
    supervisor,
    opsStore,
    surface = "web",
    senderName = "unknown",
    onAssistantMessage,
    onComplete,
  } = opts;

  const runId = crypto.randomUUID();

  // Create run/attempt rows (was dispatcher → supervisor.startMainRun)
  opsStore.insertRunOrigin({
    runId,
    conversationId,
    sourceLedgerSeq: 0,
    agentMemberId: agentId,
    surface,
    traceId: "",
    traceparent: "",
    idempotencyKey: runId,
    issueId: null,
    fromStatus: "",
    originKind: "mention",
    createdAt: Date.now(),
  });
  const { attemptId } = await supervisor.startMainRun(runId, threadId, { agentId, threadId });

  const agent = await agentSvc.getById(agentId);
  const cwd = join(config.dataDir, "agents", agentId);

  // ── Model ──────────────────────────────────────────────
  const model = new AnthropicChatModel({
    apiKey: config.anthropicApiKey,
    model: agent.modelName,
  });

  // ── Tools ──────────────────────────────────────────────
  const baseTools = [
    createReadTool({ cwd }),
    createWriteTool({ cwd }),
    createEditTool({ cwd }),
    bashTool,
    globTool,
    grepTool,
  ];

  const convTools = [
    createReadHistoryTool({ convPort, conversationId }),
    createReadContextTool({ convPort, conversationId }),
    createSearchTool({ convPort, conversationId }),
    createListMembersTool({ convPort, conversationId }),
  ];

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const convPrompt = `<conversation>
  <id>${esc(conversationId)}</id>
  <surface>${esc(surface)}</surface>
  <trigger>
    <from>${esc(senderName)}</from>
    <message>${esc(input)}</message>
  </trigger>
</conversation>
如需更多上下文，使用 read_conversation_history 等工具。`;

  // ── Plugins ────────────────────────────────────────────
  const plugins = [
    identityPlugin({ cwd }),
    conversationContextPlugin({ tools: convTools, systemPrompt: convPrompt }),
    fsMemoryPlugin({ cwd }),
    progressiveSkillPlugin({ cwd }),
  ];

  // ── Checkpointer + ContextManager ──────────────────────
  const checkpointer = sqliteCheckpointer({
    db: join(config.dataDir, "checkpointer.db"),
  });

  const contextManager = pipeContextManagers(
    toolResultTruncator({ maxCharsPerResult: 50_000 }),
    autoSummarize({ triggerAt: 100_000, keepRecent: 10 }),
  );

  // ── Session ────────────────────────────────────────────
  const session = new AgentSession({
    model,
    threadId,
    plugins,
    tools: baseTools,
    checkpointer,
    contextManager,
  });

  // Wire events → ledger + SSE
  session.subscribe((event) => {
    if (event.type === "message" && onAssistantMessage) {
      onAssistantMessage(event.payload);
    }
    if (event.type === "agent_end" && onComplete) {
      onComplete(runId, event.willRetry ? "error" : "succeeded");
    }
  });

  // Register for resume (ToolApprovalCard interrupt flow)
  registerSession(runId, session);

  await session.prompt(input);

  // Keep alive if interrupted (waiting for approval). Otherwise dispose and unregister.
  if (session.state === "waiting") {
    // Session stays alive — resumeRoute will call session.resume()
  } else {
    session.dispose();
    removeSession(runId);
  }

  return { runId, attemptId };
}
