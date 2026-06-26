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
import {
  bashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  globTool,
  grepTool,
} from "@my-agent-team/tools-common";
import type { BackendConfig } from "../../config.js";
import type { AgentService } from "../agent/index.js";
import {
  createListMembersTool,
  createReadContextTool,
  createReadHistoryTool,
  createSearchTool,
} from "../conversation/conv-tools.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import type { RunOriginKind } from "../runtime-ops/types.js";
import { registerSession, removeSession } from "./session-registry.js";
import type { RunSupervisor } from "./supervisor.js";

export interface ExecuteAgentRunOpts {
  runId: string;
  threadId: string;
  agentId: string;
  input: string;
  config: BackendConfig;
  agentSvc: AgentService;
  supervisor: RunSupervisor;
  opsStore: RuntimeOpsStore;
  /** Set for conversation-triggered runs (enables conv tools + context plugin) */
  convPort?: ConversationPort;
  conversationId?: string;
  surface?: string;
  senderName?: string;
  originKind?: RunOriginKind;
  origin?: Record<string, unknown>;
  /** Called with each assistant message revision to write to ledger + SSE */
  onAssistantMessage?: (revision: Record<string, unknown>) => void;
  /** Called when run completes (success/error/abort) */
  onComplete?: (runId: string, status: string) => void;
}

/**
 * Create an AgentSession and execute it asynchronously (fire-and-forget).
 *
 * Replaces the old forkRun → dispatcher → supervisor → daemon chain.
 * All three run paths (conversation / orchestrator / cron) call this.
 *
 * Returns immediately with {runId, attemptId} — the AgentSession runs
 * in the background. Output flows through the onAssistantMessage /
 * onComplete callbacks (wired to projection/ledger).
 */
export async function executeAgentRun(
  opts: ExecuteAgentRunOpts,
): Promise<{ runId: string; attemptId: string }> {
  const {
    runId,
    threadId,
    agentId,
    input,
    config,
    agentSvc,
    supervisor,
    opsStore,
    convPort,
    conversationId,
    surface = "web",
    senderName = "unknown",
    originKind = "manual" as RunOriginKind,
    origin = {},
    onAssistantMessage,
    onComplete,
  } = opts;

  // ── Create run/attempt rows ─────────────────────────────
  opsStore.insertRunOrigin({
    runId,
    conversationId: conversationId ?? "",
    sourceLedgerSeq: 0,
    agentMemberId: agentId,
    surface,
    traceId: "",
    traceparent: "",
    idempotencyKey: runId,
    issueId: null,
    fromStatus: "",
    originKind,
    createdAt: Date.now(),
    ...origin,
  });

  const { attemptId } = await supervisor.startMainRun(runId, threadId, { agentId, threadId });

  // ── Model ──────────────────────────────────────────────
  const agent = await agentSvc.getById(agentId);
  const cwd = join(config.dataDir, "agents", agentId);

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

  const hasConversation = convPort && conversationId;

  const convTools = hasConversation
    ? [
        createReadHistoryTool({ convPort, conversationId }),
        createReadContextTool({ convPort, conversationId }),
        createSearchTool({ convPort, conversationId }),
        createListMembersTool({ convPort, conversationId }),
      ]
    : [];

  // ── Plugins ────────────────────────────────────────────
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plugins = [
    identityPlugin({ cwd }),
    ...(hasConversation
      ? [
          conversationContextPlugin({
            tools: convTools,
            systemPrompt: `<conversation>
  <id>${esc(conversationId)}</id>
  <surface>${esc(surface)}</surface>
  <trigger>
    <from>${esc(senderName)}</from>
    <message>${esc(input)}</message>
  </trigger>
</conversation>
如需更多上下文，使用 read_conversation_history 等工具。`,
          }),
        ]
      : []),
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

  // Wire events → caller callbacks
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

  // ── Fire-and-forget execution ──────────────────────────
  // Get the abort signal from supervisor's RunSession so cancel() works
  const runSession = supervisor.getActive().get(runId);
  const signal = runSession?.abortController.signal;

  void session
    .prompt(input, { signal })
    .then(() => {
      // Run completed normally — cleanup if not waiting for approval
      if (session.state !== "waiting") {
        session.dispose();
        removeSession(runId);
      }
    })
    .catch((err) => {
      // Run failed — ensure cleanup
      if (session.state !== "waiting") {
        session.dispose();
        removeSession(runId);
      }
      console.error(
        `[run-executor] AgentSession failed for ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });

  return { runId, attemptId };
}
