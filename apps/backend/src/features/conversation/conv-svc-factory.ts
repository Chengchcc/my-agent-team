import type { Database } from "bun:sqlite";
import type { RuntimeTracer } from "@my-agent-team/runtime-observability";
import type { BackendConfig } from "../../config.js";
import { ulid } from "../../infra/ids.js";
import type { AgentService } from "../agent/index.js";
import type { RunSupervisor } from "../run/supervisor.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import {
  sqliteThreadProjectionReadAdapter,
  sqliteThreadProjectionWriteAdapter,
} from "../thread-projection/adapter-sqlite.js";
import { createThreadProjectionService } from "../thread-projection/index.js";
import { sqliteConversationAdapter } from "./index.js";
import { ConversationLock } from "./lock.js";
import type { ConversationPort } from "./ports.js";
import { buildPreloadedMessages } from "./projection.js";
import { createConversationService, parseThreadId } from "./service.js";

export interface ConversationFeature {
  convPort: ConversationPort;
  convSvc: ReturnType<typeof createConversationService>;
  threadProjectionSvc: ReturnType<typeof createThreadProjectionService>;
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
  opsStore: RuntimeOpsStore,
  tracer: RuntimeTracer,
): ConversationFeature {
  const threadProjectionPort = sqliteThreadProjectionReadAdapter(db);
  const threadProjectionWritePort = sqliteThreadProjectionWriteAdapter(db);
  const threadProjectionSvc = createThreadProjectionService({ port: threadProjectionPort });

  const convPort = sqliteConversationAdapter(db);
  const lock = new ConversationLock();

  const convSvc = createConversationService({
    port: convPort,
    threadProjectionRead: threadProjectionPort,
    threadProjectionWrite: threadProjectionWritePort,
    lock,
    maxConsecutiveAgentHops: 8,
    idGen: ulid,

    forkRun: async (runId, threadId, ctx) => {
      const spec = await buildAgentSpecV2(db, agentSvc, threadId, "", {
        runId,
        conversationId: ctx.conversationId,
        senderMemberId: ctx.agentMemberId,
      });

      const preloadedMessages = buildPreloadedMessages(
        convPort,
        ctx.conversationId,
        ctx.agentMemberId,
      );

      const members = convPort.getMembers(ctx.conversationId);
      const isLarkConversation = members.some(
        (m) => m.kind === "human" && m.userRef?.startsWith("lark:"),
      );
      const surfaceContext = isLarkConversation
        ? {
            surface: "lark" as const,
            conversationId: ctx.conversationId,
            runId,
            capabilities: ["start_new_conversation" as const],
          }
        : undefined;

      const trace = tracer.inject();

      const { attemptId } = await supervisor.startMainRun(runId, threadId, spec, {
        preloadedMessages,
        surfaceContext,
        trace,
      });

      opsStore.insertRunOrigin({
        runId,
        conversationId: ctx.conversationId,
        sourceLedgerSeq: ctx.ledgerSeq,
        agentMemberId: ctx.agentMemberId,
        surface: surfaceContext?.surface ?? "web",
        traceId: trace.traceId,
        traceparent: trace.traceparent,
        idempotencyKey: `${ctx.conversationId}:${ctx.ledgerSeq}:run`,
        fromStatus: "",
        createdAt: Date.now(),
      });

      return { runId, attemptId };
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

  return { convPort, convSvc, threadProjectionSvc, lock };
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
