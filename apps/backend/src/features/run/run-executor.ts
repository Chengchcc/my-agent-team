import type { BackendConfig } from "../../config.js";
import type { AgentService } from "../agent/index.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import type { RunOriginKind } from "../runtime-ops/types.js";
import { buildSessionSpec, type SessionFactory } from "./session-factory.js";
import type { RunSupervisor } from "./supervisor.js";

// ─── New types (PR-1) ─────────────────────────────────────

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

// ─── Legacy wrapper (backward compat during migration) ─────

/** @deprecated replaced by RunDeps + RunRequest. Kept for gradual migration of call sites. */
export interface ExecuteAgentRunOpts {
  runId: string;
  threadId: string;
  agentId: string;
  input: string;
  config: BackendConfig;
  agentSvc: AgentService;
  supervisor: RunSupervisor;
  opsStore: RuntimeOpsStore;
  convPort?: ConversationPort;
  conversationId?: string;
  surface?: string;
  senderName?: string;
  originKind?: RunOriginKind;
  origin?: Record<string, unknown>;
  onAssistantMessage?: (revision: Record<string, unknown>) => void;
  onRunStatus?: (status: {
    runId: string;
    phase: string;
    detail?: string;
    updatedAt: number;
  }) => void;
  onComplete?: (runId: string, status: string) => void;
}

// ─── Origin helpers ───────────────────────────────────────

function originFromLegacy(opts: ExecuteAgentRunOpts): {
  origin: RunOrigin;
  originKind: RunOriginKind;
  conversationId: string;
  surface: string;
  senderName: string;
} {
  const { originKind, origin, conversationId, surface, senderName } = opts;
  if (originKind === "cron") {
    return {
      origin: { kind: "cron", cronJobId: (origin?.cronJobId as string) ?? "" },
      originKind: "cron",
      conversationId: "",
      surface: "cron",
      senderName: "cron",
    };
  }
  if (originKind === "orchestrator") {
    return {
      origin: {
        kind: "orchestrator",
        issueId: (origin?.issueId as string) ?? "",
        fromStatus: (origin?.fromStatus as string) ?? "",
      },
      originKind: "orchestrator",
      conversationId: "",
      surface: "orchestrator",
      senderName: "orchestrator",
    };
  }
  return {
    origin: {
      kind: "conversation",
      conversationId: conversationId ?? "",
      surface: surface ?? "web",
      senderName: senderName ?? "unknown",
    },
    originKind: originKind ?? "manual",
    conversationId: conversationId ?? "",
    surface: surface ?? "web",
    senderName: senderName ?? "unknown",
  };
}

// ─── executeAgentRun (new signature) ──────────────────────

/**
 * Create an AgentSession (via SessionFactory) and execute it asynchronously.
 * Returns immediately — the AgentSession runs in the background.
 *
 * Phase 1: no more `new AnthropicChatModel` / `sqliteCheckpointer` /
 * `new AgentSession` / `mkdirSync` in this function body.
 * Session materialization is delegated to sessionFactory.getOrCreate,
 * and model/checkpointer/tools/plugins are assembled in buildSessionSpec.
 */
export async function executeAgentRun(
  deps: RunDeps,
  req: RunRequest,
): Promise<{ runId: string; attemptId: string; attemptSeq: number }> {
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

  const { attemptId, attemptSeq } = await supervisor.startMainRun(runId, sessionId, {
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
      .notifyRunComplete(sessionId, runId, status, "main", attemptId)
      .catch((err) => console.error(`[run-executor] notifyRunComplete failed for ${runId}:`, err));
    if (req.onComplete) req.onComplete(runId, status);
    // Phase 2: don't dispose session here (cross-run persistence)
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
      emitRunStatus("retrying", `attempt ${(event as unknown as { attempt?: number }).attempt ?? "?"}`);
    if (event.type === "auto_retry_end") emitRunStatus("running");
  });

  // ── Fire and forget (runId now flows into harness) ──────
  void session.prompt(input, { signal: undefined, runId }).catch((err) => {
    console.error(`[run-executor] prompt error for ${runId}:`, err);
    finalizeOnce("error");
  });

  return { runId, attemptId, attemptSeq };
}

// ─── Backward-compat wrapper (call sites not yet migrated to RunDeps) ──

/**
 * @deprecated Use executeAgentRun(deps: RunDeps, req: RunRequest) instead.
 * This wrapper builds a temporary SessionFactory from the legacy flat opts
 * so existing call sites don't break. Migrate callers to receive RunDeps
 * from the composition root (PR-5).
 */
export async function legacyExecuteAgentRun(
  opts: ExecuteAgentRunOpts,
): Promise<{ runId: string; attemptId: string; attemptSeq: number }> {
  const { origin } = originFromLegacy(opts);

  // Build a throwaway SessionFactory from opts.config
  const { createSessionFactory } = await import("./session-factory.js");
  const sessionFactory = createSessionFactory({ config: opts.config });

  const deps: RunDeps = {
    sessionFactory,
    supervisor: opts.supervisor,
    opsStore: opts.opsStore,
    agentSvc: opts.agentSvc,
    config: opts.config,
    convPort: opts.convPort,
  };

  const req: RunRequest = {
    runId: opts.runId,
    sessionId: opts.threadId,
    agentId: opts.agentId,
    input: opts.input,
    origin,
    onAssistantMessage: opts.onAssistantMessage,
    onRunStatus: opts.onRunStatus,
    onComplete: opts.onComplete,
  };

  return executeAgentRun(deps, req);
}
