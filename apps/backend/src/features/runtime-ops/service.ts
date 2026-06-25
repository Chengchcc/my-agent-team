import type { Database } from "bun:sqlite";
import type { EventLog } from "../event-log/index.js";
// RunnerRegistry removed — AgentSession runs in-process
import type { RunSupervisor } from "../run/supervisor.js";
import type { InsightsSummary, RunInsights } from "./insights.js";
import { getInsightsSummary, getRunInsights } from "./insights.js";
import type { RuntimeOpsStore } from "./store.js";
// runner_health removed (AgentSession runs in-process, no runner daemon)

export interface RunOpsListItem {
  runId: string;
  threadId: string;
  agentId: string;
  agentName: string;
  kind: string;
  parentRunId: string | null;
  status: string;
  traceId: string | null;
  startedAt: number;
  endedAt: number | null;
  latestAttemptId: string | null;
  heartbeatAgeMs: number | null;
  runnerTransport: "attached" | "noop" | "detached";
  lastEventType: string | null;
  lastOpsEventKind: string | null;
}

export interface RunOpsDetail {
  run: {
    runId: string;
    threadId: string;
    agentId: string;
    agentName: string;
    kind: string;
    parentRunId: string | null;
    status: string;
    traceId: string | null;
    startedAt: number;
    endedAt: number | null;
  };
  attempts: Array<{
    attemptId: string;
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
  | { ok: true; state: "abort_sent"; runId: string; attemptId: string }
  | { ok: true; state: "already_terminal"; runId: string; status: string }
  | { ok: true; state: "detached_waiting_reaper"; runId: string; heartbeatAgeMs: number | null }
  | { ok: false; error: "not_found" };

export type RecoverRunResult =
  | { state: "already_terminal"; status: string }
  | { state: "reattached"; attemptId: string }
  | { state: "marked_interrupted"; reason: "heartbeat_timeout" }
  | { state: "waiting"; reason: "heartbeat_fresh_but_transport_detached" };

export function createRuntimeOpsService(deps: {
  db: Database;
  opsStore: RuntimeOpsStore;
  supervisor: RunSupervisor;
  heartbeatTimeoutMs: number;
  eventLog: EventLog;
  /** M16.2: Resolve agent display name for ops DTOs. Falls back to agentId if absent. */
  getAgentName?: (agentId: string) => string | undefined;
}) {
  const { db, opsStore, supervisor, heartbeatTimeoutMs, eventLog, getAgentName } = deps;
  const _OFFLINE_AFTER_MS = heartbeatTimeoutMs * 2;
  const resolveName = (agentId: string) => getAgentName?.(agentId) ?? agentId;

  return {
    listRuns(params: {
      agentId?: string;
      threadId?: string;
      conversationId?: string;
      status?: string;
      limit?: number;
      transport?: "attached" | "noop" | "detached";
      heartbeat?: "fresh" | "stale";
      traceId?: string;
    }): RunOpsListItem[] {
      const raw = params.limit ?? 50;
      const limit = Number.isFinite(raw) && raw > 0 && raw <= 500 ? Math.floor(raw) : 50;
      let sql = `SELECT r.run_id, r.thread_id, r.agent_id, r.kind, r.parent_run_id, r.status, r.started_at, r.ended_at
                 FROM run r WHERE 1=1`;
      const args: (string | number)[] = [];
      if (params.agentId) {
        sql += " AND r.agent_id = ?";
        args.push(params.agentId);
      }
      if (params.threadId) {
        sql += " AND r.thread_id = ?";
        args.push(params.threadId);
      }
      if (params.conversationId) {
        // Escape LIKE wildcards so user input doesn't get interpreted as patterns
        const escaped = params.conversationId.replace(/[%_]/g, "\\$&");
        sql += " AND r.thread_id LIKE ? ESCAPE '\\'";
        args.push(`${escaped}:%`);
      }
      if (params.status) {
        sql += " AND r.status = ?";
        args.push(params.status);
      }
      sql += " ORDER BY r.started_at DESC LIMIT ?";
      args.push(limit);

      const rows = db.query(sql).all(...args) as Array<{
        run_id: string;
        thread_id: string;
        agent_id: string;
        kind: string;
        parent_run_id: string | null;
        status: string;
        started_at: number;
        ended_at: number | null;
      }>;

      let items = rows.map((r) => {
        const attempt = db
          .query(
            "SELECT attempt_id, heartbeat_at, started_at, ended_at FROM attempt WHERE run_id = ? ORDER BY started_at DESC LIMIT 1",
          )
          .get(r.run_id) as
          | {
              attempt_id: string;
              heartbeat_at: number | null;
              started_at: number;
              ended_at: number | null;
            }
          | undefined;

        const heartbeatAgeMs = attempt?.heartbeat_at ? Date.now() - attempt.heartbeat_at : null;
        const session = supervisor.getActive(r.run_id);
        const transport: RunOpsListItem["runnerTransport"] = session
          ? session.transportKind
          : "detached";

        const lastEvent = db
          .query(
            "SELECT json_extract(event, '$.type') as type, ts FROM event_log WHERE run_id = ? ORDER BY seq DESC LIMIT 1",
          )
          .get(r.run_id) as { type: string | null; ts: number | null } | undefined;

        const lastOps = opsStore.getRunEvents(r.run_id).pop();

        // Trace ID from run_origin
        const origin = opsStore.getRunOrigin(r.run_id);

        return {
          runId: r.run_id,
          threadId: r.thread_id,
          agentId: r.agent_id,
          agentName: resolveName(r.agent_id),
          kind: r.kind,
          parentRunId: r.parent_run_id,
          status: r.status,
          traceId: origin?.traceId ?? null,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          latestAttemptId: attempt?.attempt_id ?? null,
          heartbeatAgeMs,
          runnerTransport: transport,
          lastEventType: lastEvent?.type ?? null,
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

    getRunDetail(runId: string): RunOpsDetail | null {
      const run = db
        .query(
          "SELECT run_id, thread_id, agent_id, kind, parent_run_id, status, started_at, ended_at FROM run WHERE run_id = ?",
        )
        .get(runId) as Record<string, unknown> | undefined;
      if (!run) return null;

      const origin = opsStore.getRunOrigin(runId);

      // Bug 2 fix: ORDER BY started_at DESC so attempts[0] is the latest attempt.
      // Aligns with listRuns (DESC LIMIT 1) and diagnoseRun which assumes [0] = latest.
      const attempts = db
        .query(
          "SELECT attempt_id, heartbeat_at, started_at, ended_at FROM attempt WHERE run_id = ? ORDER BY started_at DESC",
        )
        .all(runId) as Array<{
        attempt_id: string;
        heartbeat_at: number | null;
        started_at: number;
        ended_at: number | null;
      }>;

      const lastEvent = db
        .query(
          "SELECT seq, json_extract(event, '$.type') as type, ts FROM event_log WHERE run_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(runId) as { seq: number | null; type: string | null; ts: number | null } | undefined;

      const ops = opsStore.getRunEvents(runId);

      return {
        run: {
          runId: run.run_id as string,
          threadId: run.thread_id as string,
          agentId: run.agent_id as string,
          agentName: resolveName(run.agent_id as string),
          kind: run.kind as string,
          parentRunId: run.parent_run_id as string | null,
          status: run.status as string,
          traceId: origin?.traceId ?? null,
          startedAt: run.started_at as number,
          endedAt: run.ended_at as number | null,
        },
        // Bug 6 fix: only apply live session transport to unfinished attempts.
        // Historical (ended) attempts have no reliable real-time transport; mark as detached.
        attempts: attempts.map((a) => {
          const session = a.ended_at == null ? supervisor.getActive(runId) : null;
          const transport: "attached" | "noop" | "detached" = session
            ? session.transportKind
            : "detached";
          return {
            attemptId: a.attempt_id,
            heartbeatAt: a.heartbeat_at,
            heartbeatAgeMs: a.heartbeat_at ? Date.now() - a.heartbeat_at : null,
            startedAt: a.started_at,
            endedAt: a.ended_at,
            transport,
          };
        }),
        eventLog: {
          lastSeq: lastEvent?.seq ?? null,
          lastEventType: lastEvent?.type ?? null,
          lastEventAt: lastEvent?.ts ?? null,
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

    cancel(runId: string): CancelRunResult {
      const run = db.query("SELECT status FROM run WHERE run_id = ?").get(runId) as
        | { status: string }
        | undefined;
      if (!run) return { ok: false, error: "not_found" };

      if (run.status !== "running") {
        return { ok: true, state: "already_terminal", runId, status: run.status };
      }

      const session = supervisor.getActive(runId);
      if (!session) return { ok: false, error: "not_found" };

      const cancelled = supervisor.cancel(runId);
      if (!cancelled) return { ok: false, error: "not_found" };

      return { ok: true, state: "abort_sent", runId, attemptId: session.attemptId };
    },

    async recover(runId: string): Promise<RecoverRunResult> {
      const run = db
        .query("SELECT status, agent_id, thread_id, kind FROM run WHERE run_id = ?")
        .get(runId) as
        | { status: string; agent_id: string; thread_id: string; kind: string }
        | undefined;
      if (!run) return { state: "already_terminal", status: "not_found" };
      if (run.status !== "running") return { state: "already_terminal", status: run.status };

      const attempt = db
        .query(
          "SELECT attempt_id, heartbeat_at FROM attempt WHERE run_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
        )
        .get(runId) as { attempt_id: string; heartbeat_at: number | null } | undefined;

      if (!attempt) return { state: "already_terminal", status: "unknown" };

      const age = attempt.heartbeat_at ? Math.max(0, Date.now() - attempt.heartbeat_at) : Infinity;
      if (age >= heartbeatTimeoutMs) {
        // M16.1: stale heartbeat → go through reaper terminal path (write EventLog + trigger onRunComplete)
        const now = Date.now();
        db.transaction(() => {
          db.run("UPDATE run SET status = 'interrupted', ended_at = ? WHERE run_id = ?", [
            now,
            runId,
          ]);
          db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [now, attempt.attempt_id]);
        })();
        opsStore.appendRunEvent({
          runId,
          attemptId: attempt.attempt_id,
          kind: "recover_requested",
          payload: { reason: "heartbeat_timeout" },
        });
        // Append terminal event to EventLog (same as reaper path)
        try {
          await eventLog.append(run.thread_id, runId, {
            type: "interrupted",
            payload: { reason: "heartbeat_timeout" },
          });
        } catch {
          // EventLog append is best-effort
        }
        // Trigger onRunComplete listeners
        // Trigger onRunComplete listeners (same as reaper path)
        supervisor.notifyRunComplete(run.thread_id, runId, "interrupted", run.kind);
        return { state: "marked_interrupted", reason: "heartbeat_timeout" };
      }

      // Runner daemon removed — AgentSession runs in-process, no reattachment
      // Previously: try to reattach to existing daemon transport
      // Now: stale runs are marked interrupted by the reaper

      return { state: "waiting", reason: "heartbeat_fresh_but_transport_detached" };
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
        runId: string;
        attemptId: string | null;
        kind: string;
        payload: Record<string, unknown>;
      }>;
    } | null {
      // Find all runs with this trace ID
      const origins = opsStore.listRunOrigins().filter((o) => o.traceId === traceId);
      if (origins.length === 0) {
        // Also check run_ops_event for trace_id
        const opsEvents = opsStore.getRunEventsByTrace(traceId);
        if (opsEvents.length === 0) return null;
      }

      const events = opsStore.getRunEventsByTrace(traceId).map((e) => ({
        ts: e.ts,
        runId: e.runId,
        attemptId: e.attemptId,
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

    async getRunInsights(runId: string): Promise<RunInsights | null> {
      const run = db
        .query(
          "SELECT run_id, thread_id, agent_id, status, started_at, ended_at FROM run WHERE run_id = ?",
        )
        .get(runId) as
        | {
            run_id: string;
            thread_id: string;
            agent_id: string;
            status: string;
            started_at: number;
            ended_at: number | null;
          }
        | undefined;
      if (!run) return null;

      return getRunInsights(
        { eventLog, getAgentName },
        {
          runId: run.run_id,
          threadId: run.thread_id,
          agentId: run.agent_id,
          status: run.status,
          startedAt: run.started_at,
          endedAt: run.ended_at,
        },
      );
    },

    async getInsightsSummary(range: { from: number; to: number }): Promise<InsightsSummary> {
      // Scope to runs in the time window (avoid full event_log scan)
      const runRows = db
        .query(
          "SELECT run_id, agent_id FROM run WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) LIMIT 500",
        )
        .all(range.to, range.from) as Array<{ run_id: string; agent_id: string }>;

      const runAgentMap = new Map<string, string>();
      for (const r of runRows) runAgentMap.set(r.run_id, r.agent_id);

      return getInsightsSummary(
        {
          eventLog,
          getAgentName,
          runAgentMap,
        },
        range,
      );
    },
  };
}

export type RuntimeOpsService = ReturnType<typeof createRuntimeOpsService>;
