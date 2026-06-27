import type { Database } from "bun:sqlite";
// event_log removed — execution facts now in checkpointer.db
// RunnerRegistry removed — AgentSession runs in-process
import type { SpanSupervisor } from "../span/supervisor.js";
import type { CheckpointEventsStore } from "./checkpoint-events-store.js";
import type { InsightsSummary, RunInsights } from "./insights.js";
import { getInsightsSummary, getRunInsights } from "./insights.js";
import { buildRunQuery } from "./span-query-service.js";
import type { RuntimeOpsStore } from "./store.js";
// runner_health removed (AgentSession runs in-process, no runner daemon)

export interface RunOpsListItem {
  spanId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  kind: string;
  parentSpanId: string | null;
  status: string;
  traceId: string | null;
  startedAt: number;
  endedAt: number | null;
  latestAttemptSeq: number | null;
  heartbeatAgeMs: number | null;
  runnerTransport: "attached" | "noop" | "detached";
  lastEventType: string | null;
  lastOpsEventKind: string | null;
}

export interface RunOpsDetail {
  run: {
    spanId: string;
    sessionId: string;
    agentId: string;
    agentName: string;
    kind: string;
    parentSpanId: string | null;
    status: string;
    traceId: string | null;
    startedAt: number;
    endedAt: number | null;
  };
  attempts: Array<{
    attemptSeq: number;
    heartbeatAt: number | null;
    heartbeatAgeMs: number | null;
    startedAt: number;
    endedAt: number | null;
    transport: "attached" | "noop" | "detached";
  }>;
  eventLog: {
    lastSeq: number | null;
    lastEventType: string | null;
    lastEventAt: number | null;
  };
  ops: Array<{
    seq: number;
    kind: string;
    payload: Record<string, unknown>;
    traceId: string | null;
    ts: number;
  }>;
}

export interface AgentRuntimeStatus {
  agentId: string;
  agentName: string;
  heartbeatTimeoutMs: number;
  surfaces: Record<
    string,
    {
      status: string;
      lastSeenAt: number | null;
      lastError: string | null;
      counters: Record<string, number>;
    }
  >;
}

export type CancelRunResult =
  | { ok: true; state: "abort_sent"; spanId: string; attemptSeq: number }
  | { ok: true; state: "already_terminal"; spanId: string; status: string }
  | { ok: true; state: "detached_waiting_reaper"; spanId: string; heartbeatAgeMs: number | null }
  | { ok: false; error: "not_found" };

export type RecoverRunResult =
  | { state: "already_terminal"; status: string }
  | { state: "reattached"; attemptSeq: number }
  | { state: "marked_interrupted"; reason: "heartbeat_timeout" }
  | { state: "waiting"; reason: "heartbeat_fresh_but_transport_detached" };

export function createRuntimeOpsService(deps: {
  db: Database;
  opsStore: RuntimeOpsStore;
  supervisor: SpanSupervisor;
  heartbeatTimeoutMs: number;
  checkpointEventsStore?: CheckpointEventsStore;
  /** M16.2: Resolve agent display name for ops DTOs. Falls back to agentId if absent. */
  getAgentName?: (agentId: string) => string | undefined;
}) {
  const { db, opsStore, supervisor, heartbeatTimeoutMs, checkpointEventsStore, getAgentName } =
    deps;
  const _OFFLINE_AFTER_MS = heartbeatTimeoutMs * 2;
  const resolveName = (agentId: string) => getAgentName?.(agentId) ?? agentId;

  return {
    listRuns(params: {
      agentId?: string;
      sessionId?: string;
      conversationId?: string;
      status?: string;
      limit?: number;
      transport?: "attached" | "noop" | "detached";
      heartbeat?: "fresh" | "stale";
      traceId?: string;
    }): RunOpsListItem[] {
      const raw = params.limit ?? 50;
      const limit = Number.isFinite(raw) && raw > 0 && raw <= 500 ? Math.floor(raw) : 50;
      // DI#4: SQL building extracted to narrow query constructor (OCP fix)
      const { sql, args } = buildRunQuery(
        {
          agentId: params.agentId,
          sessionId: params.sessionId,
          conversationId: params.conversationId,
          status: params.status,
        },
        limit,
      );

      const rows = db.query(sql).all(...args) as Array<{
        span_id: string;
        session_id: string;
        agent_id: string;
        kind: string;
        parent_span_id: string | null;
        status: string;
        started_at: number;
        ended_at: number | null;
      }>;

      let items = rows.map((r) => {
        const attempt = db
          .query(
            "SELECT seq, heartbeat_at, started_at, ended_at FROM attempt WHERE span_id = ? ORDER BY seq DESC LIMIT 1",
          )
          .get(r.span_id) as
          | {
              seq: number;
              heartbeat_at: number | null;
              started_at: number;
              ended_at: number | null;
            }
          | undefined;

        const heartbeatAgeMs = attempt?.heartbeat_at ? Date.now() - attempt.heartbeat_at : null;
        const session = supervisor.getActive().get(r.span_id);
        const transport: RunOpsListItem["runnerTransport"] = session
          ? session.transportKind
          : "detached";

        // Read last execution fact from checkpoint_events (live source, replaces dead event_log)
        const factEvents = checkpointEventsStore?.readBySpan(r.session_id, r.span_id) ?? [];
        const lastFact = factEvents.at(-1);

        const lastOps = opsStore.getRunEvents(r.span_id).pop();

        // Trace ID from run_origin
        const origin = opsStore.getSpanOrigin(r.span_id);

        return {
          spanId: r.span_id,
          sessionId: r.session_id,
          agentId: r.agent_id,
          agentName: resolveName(r.agent_id),
          kind: r.kind,
          parentSpanId: r.parent_span_id,
          status: r.status,
          traceId: origin?.traceId ?? null,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          latestAttemptSeq: attempt?.seq ?? null,
          heartbeatAgeMs,
          runnerTransport: transport,
          lastEventType: lastFact?.type ?? null,
          lastOpsEventKind: lastOps?.kind ?? null,
        };
      });

      // M16.2 G1: Post-query filtering for transport/heartbeat/traceId
      if (params.transport) {
        items = items.filter((i) => i.runnerTransport === params.transport);
      }
      if (params.heartbeat === "stale") {
        items = items.filter(
          (i) => i.heartbeatAgeMs != null && i.heartbeatAgeMs > heartbeatTimeoutMs,
        );
      }
      if (params.heartbeat === "fresh") {
        items = items.filter(
          (i) => i.heartbeatAgeMs != null && i.heartbeatAgeMs <= heartbeatTimeoutMs,
        );
      }
      if (params.traceId) {
        items = items.filter((i) => i.traceId === params.traceId);
      }
      return items;
    },

    getRunDetail(spanId: string): RunOpsDetail | null {
      const run = db
        .query(
          "SELECT span_id, session_id, agent_id, kind, parent_span_id, status, started_at, ended_at FROM run WHERE span_id = ?",
        )
        .get(spanId) as Record<string, unknown> | undefined;
      if (!run) return null;

      const origin = opsStore.getSpanOrigin(spanId);

      // Bug 2 fix: ORDER BY started_at DESC so attempts[0] is the latest attempt.
      // Aligns with listRuns (DESC LIMIT 1) and diagnoseRun which assumes [0] = latest.
      const attempts = db
        .query(
          "SELECT seq, heartbeat_at, started_at, ended_at FROM attempt WHERE span_id = ? ORDER BY seq DESC",
        )
        .all(spanId) as Array<{
        seq: number;
        heartbeat_at: number | null;
        started_at: number;
        ended_at: number | null;
      }>;

      // Read execution facts from checkpoint_events (live source, replaces dead event_log)
      const sessionId = run.session_id as string;
      const factEvents = checkpointEventsStore?.readBySpan(sessionId, spanId) ?? [];
      const lastFact = factEvents.at(-1);

      const ops = opsStore.getRunEvents(spanId);

      return {
        run: {
          spanId: run.span_id as string,
          sessionId,
          agentId: run.agent_id as string,
          agentName: resolveName(run.agent_id as string),
          kind: run.kind as string,
          parentSpanId: run.parent_span_id as string | null,
          status: run.status as string,
          traceId: origin?.traceId ?? null,
          startedAt: run.started_at as number,
          endedAt: run.ended_at as number | null,
        },
        // Bug 6 fix: only apply live session transport to unfinished attempts.
        // Historical (ended) attempts have no reliable real-time transport; mark as detached.
        attempts: attempts.map((a) => {
          const session = a.ended_at == null ? supervisor.getActive().get(spanId) : null;
          const transport: "attached" | "noop" | "detached" = session
            ? session.transportKind
            : "detached";
          return {
            attemptSeq: a.seq,
            heartbeatAt: a.heartbeat_at,
            heartbeatAgeMs: a.heartbeat_at ? Date.now() - a.heartbeat_at : null,
            startedAt: a.started_at,
            endedAt: a.ended_at,
            transport,
          };
        }),
        eventLog: {
          lastSeq: factEvents.length > 0 ? factEvents.length : null,
          lastEventType: lastFact?.type ?? null,
          lastEventAt: lastFact?.ts ?? null,
        },
        ops: ops.map((o) => ({
          seq: o.seq,
          kind: o.kind,
          payload: o.payload,
          traceId: o.traceId,
          ts: o.ts,
        })),
      };
    },

    cancel(spanId: string): CancelRunResult {
      const run = db.query("SELECT status FROM run WHERE span_id = ?").get(spanId) as
        | { status: string }
        | undefined;
      if (!run) return { ok: false, error: "not_found" };

      if (run.status !== "running") {
        return { ok: true, state: "already_terminal", spanId, status: run.status };
      }

      const session = supervisor.getActive().get(spanId);
      if (!session) return { ok: false, error: "not_found" };

      const cancelled = supervisor.cancel(spanId);
      if (!cancelled) return { ok: false, error: "not_found" };

      return {
        ok: true,
        state: "abort_sent",
        spanId,
        attemptSeq: session.attemptSeq,
      };
    },

    async recover(spanId: string): Promise<RecoverRunResult> {
      const run = db
        .query("SELECT status, agent_id, session_id, kind FROM run WHERE span_id = ?")
        .get(spanId) as
        | { status: string; agent_id: string; session_id: string; kind: string }
        | undefined;
      if (!run) return { state: "already_terminal", status: "not_found" };
      if (run.status !== "running") return { state: "already_terminal", status: run.status };

      // heartbeat_at is never written post-daemon removal.
      // Alive check: is the run still tracked by supervisor?
      if (supervisor.getActive().has(spanId)) {
        // Session still active in this process — no recovery needed
        return { state: "already_terminal", status: run.status };
      }

      // Run is DB-running but not in memory (process restart orphan).
      // Use notifyRunComplete for single-completion-authority finalization.
      await supervisor.notifyRunComplete(run.session_id, spanId, "interrupted", run.kind);
      return { state: "marked_interrupted", reason: "heartbeat_timeout" };
    },

    getAgentRuntime(agentId: string): AgentRuntimeStatus | null {
      const surfaceHealths = opsStore.getSurfaceHealthsForAgent(agentId);

      const surfaces: AgentRuntimeStatus["surfaces"] = {};
      for (const sh of surfaceHealths) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(sh.payload);
        } catch {
          /* keep empty */
        }
        surfaces[sh.surface] = {
          status: sh.status,
          lastSeenAt: sh.lastSeenAt,
          lastError: sh.lastError,
          counters: payload as Record<string, number>,
        };
      }

      // runner health removed — AgentSession runs in-process, no daemon health tracking
      return {
        agentId,
        agentName: resolveName(agentId),
        heartbeatTimeoutMs,
        surfaces,
      };
    },

    ingestLarkHeartbeat(body: {
      agentId: string;
      profileRef: string;
      status: string;
      watchers: { conversation: number; runDelta: number };
      runStreams: Record<string, number>;
      lastError: string | null;
      ts: number;
    }): void {
      opsStore.upsertSurfaceHealth({
        agentId: body.agentId,
        surface: "lark",
        status: body.status,
        payload: {
          watchers: body.watchers,
          runStreams: body.runStreams,
          profileRef: body.profileRef,
        },
        lastError: body.lastError ?? undefined,
      });
    },

    // ─── M16.1: Trace detail (local waterfall) ───

    getTraceDetail(traceId: string): {
      traceId: string;
      mode: "local" | "otlp";
      runs: RunOpsListItem[];
      events: Array<{
        ts: number;
        spanId: string;
        attemptSeq: number | null;
        kind: string;
        payload: Record<string, unknown>;
      }>;
    } | null {
      // Find all runs with this trace ID
      const origins = opsStore.listSpanOrigins().filter((o) => o.traceId === traceId);
      if (origins.length === 0) {
        // Also check run_ops_event for trace_id
        const opsEvents = opsStore.getRunEventsByTrace(traceId);
        if (opsEvents.length === 0) return null;
      }

      const events = opsStore.getRunEventsByTrace(traceId).map((e) => ({
        ts: e.ts,
        spanId: e.spanId,
        attemptSeq: e.attemptSeq,
        kind: e.kind,
        payload: e.payload,
      }));

      const runs = this.listRuns({ limit: 500 }).filter((r) => r.traceId === traceId);

      return {
        traceId,
        mode: "local",
        runs,
        events: events.sort((a, b) => a.ts - b.ts),
      };
    },

    // ─── M16.1: Surface diagnostics ───

    listSurfaces(): Array<{
      agentId: string;
      surface: string;
      status: string;
      lastSeenAt: number | null;
      lastError: string | null;
      counters: Record<string, number>;
    }> {
      const all = opsStore.listSurfaceHealths();
      return all.map((sh) => {
        let raw: Record<string, unknown> = {};
        try {
          raw = JSON.parse(sh.payload);
        } catch {
          /* keep empty */
        }

        // Flatten nested payload into single-level Record<string, number>.
        // Nested objects become dot-separated keys (e.g. watchers.conversation).
        // Non-number values and sensitive identifiers (profileRef, chat_id, open_id)
        // are discarded, ensuring redaction at every nesting level.
        const counters: Record<string, number> = {};
        const flatten = (obj: unknown, prefix: string) => {
          if (!obj || typeof obj !== "object") return;
          for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            if (k === "profileRef" || k === "chat_id" || k === "open_id") continue;
            const key = prefix ? `${prefix}.${k}` : k;
            if (typeof v === "number") {
              counters[key] = v;
            } else if (v && typeof v === "object") {
              flatten(v, key);
            }
            // String/boolean/null values are intentionally dropped
          }
        };
        flatten(raw, "");

        return {
          agentId: sh.agentId,
          agentName: resolveName(sh.agentId),
          surface: sh.surface,
          status: sh.status,
          lastSeenAt: sh.lastSeenAt,
          lastError: sh.lastError,
          counters,
        };
      });
    },

    // ─── M16.3: Run Insights ───

    async getRunInsights(spanId: string): Promise<RunInsights | null> {
      const run = db
        .query(
          "SELECT span_id, session_id, agent_id, status, started_at, ended_at FROM run WHERE span_id = ?",
        )
        .get(spanId) as
        | {
            span_id: string;
            session_id: string;
            agent_id: string;
            status: string;
            started_at: number;
            ended_at: number | null;
          }
        | undefined;
      if (!run) return null;

      return getRunInsights(
        { checkpointEventsStore, getAgentName },
        {
          spanId: run.span_id,
          sessionId: run.session_id,
          agentId: run.agent_id,
          status: run.status,
          startedAt: run.started_at,
          endedAt: run.ended_at,
        },
      );
    },

    async getInsightsSummary(range: { from: number; to: number }): Promise<InsightsSummary> {
      // Scope to runs in the time window (avoid full scan)
      const runRows = db
        .query(
          "SELECT span_id, agent_id FROM run WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) LIMIT 500",
        )
        .all(range.to, range.from) as Array<{ span_id: string; agent_id: string }>;

      const runAgentMap = new Map<string, string>();
      for (const r of runRows) runAgentMap.set(r.span_id, r.agent_id);

      return getInsightsSummary(
        {
          checkpointEventsStore,
          getAgentName,
          runAgentMap,
        },
        range,
      );
    },
  };
}

export type RuntimeOpsService = ReturnType<typeof createRuntimeOpsService>;
