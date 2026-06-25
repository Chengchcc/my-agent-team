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
import { conversationContextPlugin } from "@my-agent-team/plugin-conversation-context";
import { fsMemoryPlugin } from "@my-agent-team/plugin-fs-memory";
import { identityPlugin } from "@my-agent-team/plugin-identity";
import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import type { RuntimeTracer } from "@my-agent-team/runtime-observability";
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

// ─── Spec builder (shared by forkRun and HTTP run routes) ──────

/** M14.7: Single spec builder for all run modes. Reads agent config for model/permission/maxSteps. */
export async function buildAgentSpecV2(
  db: Database,
  agentSvc: AgentService,
  threadId: string,
  input: string,
  overrides?: {
    runId?: string;
    mode?: "run" | "resume" | "reflect";
    resumeCommand?: { approved: boolean; message?: string };
    conversationId?: string;
    senderMemberId?: string;
    parentRunId?: string;
  },
): Promise<Record<string, unknown>> {
  const { conversationId: cid, memberId } = parseThreadId(threadId);
  const member = db
    .query("SELECT agent_id FROM member WHERE conversation_id = ? AND member_id = ?")
    .get(cid, memberId) as { agent_id: string } | undefined;
  const agentId = member?.agent_id ?? memberId;
  const agent = await agentSvc.getById(agentId);
  return {
    schemaVersion: "2",
    agentId,
    threadId,
    runId: overrides?.runId ?? crypto.randomUUID(),
    mode: overrides?.mode ?? "run",
    input,
    model: {
      provider: agent.modelProvider,
      model: agent.modelName,
      ...(agent.modelBaseUrl ? { baseURL: agent.modelBaseUrl } : {}),
    },
    permissionMode: agent.permissionMode ?? "ask",
    maxSteps: agent.maxSteps ?? undefined,
    ...overrides,
  };
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
  onComplete?: (status: string) => void;
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

  const convPrompt = `<conversation>
  <id>${conversationId}</id>
  <surface>${surface}</surface>
  <trigger>
    <from>${senderName}</from>
    <message>${input}</message>
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
      onComplete(event.willRetry ? "error" : "succeeded");
    }
  });

  await session.prompt(input);
  session.dispose();

  return { runId, attemptId };
}
