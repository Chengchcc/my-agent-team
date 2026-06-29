import type { BackendConfig } from "../../config.js";
import type { AgentService } from "../agent/index.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import type { SpanOriginKind } from "../runtime-ops/types.js";
import {
  buildSessionSpec,
  createSessionFactory,
  type ModelFactory,
  type SessionFactory,
} from "./session-factory.js";
import type { SpanSupervisor } from "./supervisor.js";

// ─── Types ────────────────────────────────────────────────

/** Stable capabilities, assembled once at the composition root. */
export interface RunDeps {
  sessionFactory: SessionFactory;
  supervisor: SpanSupervisor;
  opsStore: RuntimeOpsStore;
  agentSvc: AgentService;
  config: BackendConfig;
  convPort?: ConversationPort;
  /** Injected model factory — passed through to buildSessionSpec. */
  makeModel?: ModelFactory;
}

/** Per-invocation data that changes on every run. */
export interface RunRequest {
  spanId: string;
  sessionId: string;
  agentId: string;
  input: string;
  origin: SpanOrigin;
  onAssistantMessage?: (revision: Record<string, unknown>) => void;
  onTodoUpdate?: (todos: Array<{ step: string; status: string }>) => void;
  onRunStatus?: (status: {
    spanId: string;
    phase: string;
    detail?: string;
    updatedAt: number;
  }) => void;
  onComplete?: (spanId: string, status: string) => void;
}

/** Discriminated union replacing surface/senderName/originKind/origin/conversationId. */
export type SpanOrigin =
  | { kind: "conversation"; conversationId: string; surface: string; senderName: string }
  | { kind: "cron"; cronJobId: string }
  | { kind: "orchestrator"; issueId: string; fromStatus: string };

// ─── makeRunDeps helper ────────────────────────────────────

export function makeRunDeps(overrides: {
  config: BackendConfig;
  supervisor: SpanSupervisor;
  opsStore: RuntimeOpsStore;
  agentSvc: AgentService;
  convPort?: ConversationPort;
  makeModel?: ModelFactory;
  /** Shared SessionFactory — when omitted, creates a new one (backward compat for tests). */
  sessionFactory?: SessionFactory;
}): RunDeps {
  return {
    sessionFactory:
      overrides.sessionFactory ??
      createSessionFactory({
        config: overrides.config,
        makeModel: overrides.makeModel,
      }),
    supervisor: overrides.supervisor,
    opsStore: overrides.opsStore,
    agentSvc: overrides.agentSvc,
    config: overrides.config,
    convPort: overrides.convPort,
    makeModel: overrides.makeModel,
  };
}

// ─── executeAgentRun ──────────────────────────────────────

/**
 * Create an AgentSession (via SessionFactory) and execute it asynchronously.
 * Returns immediately — the AgentSession runs in the background.
 */
export async function executeAgentRun(
  deps: RunDeps,
  req: RunRequest,
): Promise<{ spanId: string; attemptSeq: number }> {
  const { spanId, sessionId, agentId, input, origin } = req;
  const { supervisor, opsStore, agentSvc, convPort, config, sessionFactory } = deps;

  // ── Derive origin metadata for run_origin table ──────────
  let originKind: SpanOriginKind = "manual";
  let conversationId = "";
  let surface = "web";
  let senderName = "unknown";
  let originPayload: Record<string, unknown> = {};

  if (origin.kind === "conversation") {
    originKind = "manual";
    conversationId = origin.conversationId;
    surface = origin.surface;
    senderName = origin.senderName;
  } else if (origin.kind === "cron") {
    originKind = "cron";
    originPayload = { cronJobId: origin.cronJobId };
  } else if (origin.kind === "orchestrator") {
    originKind = "orchestrator";
    originPayload = { issueId: origin.issueId, fromStatus: origin.fromStatus };
  }

  // ── Create run/attempt rows ─────────────────────────────
  opsStore.insertSpanOrigin({
    spanId,
    conversationId,
    sourceLedgerSeq: 0,
    agentMemberId: agentId,
    surface,
    traceId: "",
    traceparent: "",
    idempotencyKey: spanId,
    issueId: null,
    fromStatus: "",
    originKind,
    createdAt: Date.now(),
    ...originPayload,
  });

  const { attemptSeq } = await supervisor.startMainRun(spanId, sessionId, {
    agentId,
    sessionId,
  });

  // ── Materialize session via factory ─────────────────────
  const agent = await agentSvc.getById(agentId);
  const spec = buildSessionSpec({
    agent,
    agentId,
    config,
    convPort,
    conversationId,
    surface,
    senderName,
    input,
    makeModel: deps.makeModel,
  });
  const session = sessionFactory.getOrCreate(sessionId, spec);

  // ── Completion wiring ───────────────────────────────────
  let finalized = false;
  const finalizeOnce = (status: string, errorMessage?: string) => {
    if (finalized) return;
    finalized = true;
    void supervisor
      .notifyRunComplete(sessionId, spanId, status, "main", attemptSeq, errorMessage)
      .catch((err) => console.error(`[run-executor] notifyRunComplete failed for ${spanId}:`, err));
    if (req.onComplete) req.onComplete(spanId, status);
  };

  session.subscribe((event) => {
    if (event.type === "message" && req.onAssistantMessage) {
      req.onAssistantMessage(event.payload);
    }
    if (event.type === "todo_update" && req.onTodoUpdate) {
      req.onTodoUpdate(event.payload.todos);
    }
    if (event.type === "agent_end") {
      finalizeOnce(event.status ?? "succeeded", event.errorMessage);
    }
    const emitRunStatus = (phase: string, detail?: string) =>
      req.onRunStatus?.({ spanId, phase, detail, updatedAt: Date.now() });

    if (event.type === "compaction_start") emitRunStatus("compacting");
    if (event.type === "compaction_end") emitRunStatus("running");
    if (event.type === "auto_retry_start")
      emitRunStatus(
        "retrying",
        `attempt ${(event as unknown as { attempt?: number }).attempt ?? "?"}`,
      );
    if (event.type === "auto_retry_end") emitRunStatus("running");
  });

  // ── Fire and forget (spanId flows into harness) ──────────
  // Enqueue via factory so concurrent prompts on the same sessionId serialize
  void sessionFactory
    .enqueuePrompt(sessionId, input, { signal: undefined, spanId })
    .catch((err) => {
      console.error(`[run-executor] prompt error for ${spanId}:`, err);
      finalizeOnce("error");
    });

  return { spanId, attemptSeq };
}
