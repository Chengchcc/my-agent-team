import type { BackendConfig } from "../../config.js";
import type { AgentService } from "../agent/index.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import type { RunOriginKind } from "../runtime-ops/types.js";
import { buildSessionSpec, createSessionFactory, type SessionFactory } from "./session-factory.js";
import type { RunSupervisor } from "./supervisor.js";

// ─── Types ────────────────────────────────────────────────

/** Stable capabilities, assembled once at the composition root. */
export interface RunDeps {
  sessionFactory: SessionFactory;
  supervisor: RunSupervisor;
  opsStore: RuntimeOpsStore;
  agentSvc: AgentService;
  config: BackendConfig;
  convPort?: ConversationPort;
}

/** Per-invocation data that changes on every run. */
export interface RunRequest {
  runId: string;
  sessionId: string;
  agentId: string;
  input: string;
  origin: RunOrigin;
  onAssistantMessage?: (revision: Record<string, unknown>) => void;
  onRunStatus?: (status: {
    runId: string;
    phase: string;
    detail?: string;
    updatedAt: number;
  }) => void;
  onComplete?: (runId: string, status: string) => void;
}

/** Discriminated union replacing surface/senderName/originKind/origin/conversationId. */
export type RunOrigin =
  | { kind: "conversation"; conversationId: string; surface: string; senderName: string }
  | { kind: "cron"; cronJobId: string }
  | { kind: "orchestrator"; issueId: string; fromStatus: string };

// ─── makeRunDeps helper ────────────────────────────────────

export function makeRunDeps(overrides: {
  config: BackendConfig;
  supervisor: RunSupervisor;
  opsStore: RuntimeOpsStore;
  agentSvc: AgentService;
  convPort?: ConversationPort;
}): RunDeps {
  return {
    sessionFactory: createSessionFactory({ config: overrides.config }),
    supervisor: overrides.supervisor,
    opsStore: overrides.opsStore,
    agentSvc: overrides.agentSvc,
    config: overrides.config,
    convPort: overrides.convPort,
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
): Promise<{ runId: string; attemptSeq: number }> {
  const { runId, sessionId, agentId, input, origin } = req;
  const { supervisor, opsStore, agentSvc, convPort, config, sessionFactory } = deps;

  // ── Derive origin metadata for run_origin table ──────────
  let originKind: RunOriginKind = "manual";
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
    originKind,
    createdAt: Date.now(),
    ...originPayload,
  });

  const { attemptSeq } = await supervisor.startMainRun(runId, sessionId, {
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
  });
  const session = sessionFactory.getOrCreate(sessionId, spec);

  // ── Completion wiring ───────────────────────────────────
  let finalized = false;
  const finalizeOnce = (status: string) => {
    if (finalized) return;
    finalized = true;
    void supervisor
      .notifyRunComplete(sessionId, runId, status, "main", attemptSeq)
      .catch((err) => console.error(`[run-executor] notifyRunComplete failed for ${runId}:`, err));
    if (req.onComplete) req.onComplete(runId, status);
  };

  session.subscribe((event) => {
    if (event.type === "message" && req.onAssistantMessage) {
      req.onAssistantMessage(event.payload);
    }
    if (event.type === "agent_end") {
      finalizeOnce(event.status ?? "succeeded");
    }
    const emitRunStatus = (phase: string, detail?: string) =>
      req.onRunStatus?.({ runId, phase, detail, updatedAt: Date.now() });

    if (event.type === "compaction_start") emitRunStatus("compacting");
    if (event.type === "compaction_end") emitRunStatus("running");
    if (event.type === "auto_retry_start")
      emitRunStatus(
        "retrying",
        `attempt ${(event as unknown as { attempt?: number }).attempt ?? "?"}`,
      );
    if (event.type === "auto_retry_end") emitRunStatus("running");
  });

  // ── Fire and forget (runId flows into harness) ──────────
  // Enqueue via factory so concurrent prompts on the same sessionId serialize
  void sessionFactory.enqueuePrompt(sessionId, input, { signal: undefined, runId }).catch((err) => {
    console.error(`[run-executor] prompt error for ${runId}:`, err);
    finalizeOnce("error");
  });

  return { runId, attemptSeq };
}
