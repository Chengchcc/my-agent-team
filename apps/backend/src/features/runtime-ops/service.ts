import type { Database } from "bun:sqlite";
import { RuntimeOpsStore } from "./store.js";
import { computeRunnerStatus } from "./types.js";
import type { RunnerHealthStatus, RunnerHealthRow } from "./types.js";
import type { RunSupervisor } from "../run/supervisor.js";
import type { RunnerRegistry } from "../run/runner-registry.js";

export interface RunOpsListItem {
  runId: string;
  threadId: string;
  agentId: string;
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
  runner: {
    status: RunnerHealthStatus;
    lastSeenAt: number | null;
    uptimeMs: number;
    activeRunCount: number;
    checkpointerOk: boolean;
    workspaceOk: boolean;
    lastError: string | null;
  };
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
  registry: RunnerRegistry;
  heartbeatTimeoutMs: number;
}) {
  const { db, opsStore, supervisor, registry, heartbeatTimeoutMs } = deps;
  const OFFLINE_AFTER_MS = heartbeatTimeoutMs * 2;

  return {
    listRuns(params: {
      agentId?: string;
      threadId?: string;
      conversationId?: string;
      status?: string;
      limit?: number;
    }): RunOpsListItem[] {
      const limit = params.limit ?? 50;
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
        sql += " AND r.thread_id LIKE ?";
        args.push(`${params.conversationId}:%`);
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

      return rows.map((r) => {
        const attempt = db
          .query(
            "SELECT attempt_id, heartbeat_at, started_at, ended_at FROM attempt WHERE run_id = ? ORDER BY started_at DESC LIMIT 1",
          )
          .get(r.run_id) as
          | { attempt_id: string; heartbeat_at: number | null; started_at: number; ended_at: number | null }
          | undefined;

        const heartbeatAgeMs =
          attempt?.heartbeat_at ? Date.now() - attempt.heartbeat_at : null;
        const session = supervisor.getActive(r.run_id);
        const transport: RunOpsListItem["runnerTransport"] = session
          ? "attached"
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
    },

    getRunDetail(runId: string): RunOpsDetail | null {
      const run = db
        .query(
          "SELECT run_id, thread_id, agent_id, kind, parent_run_id, status, started_at, ended_at FROM run WHERE run_id = ?",
        )
        .get(runId) as Record<string, unknown> | undefined;
      if (!run) return null;

      const origin = opsStore.getRunOrigin(runId);

      const attempts = db
        .query(
          "SELECT attempt_id, heartbeat_at, started_at, ended_at FROM attempt WHERE run_id = ? ORDER BY started_at",
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
        .get(runId) as
        | { seq: number | null; type: string | null; ts: number | null }
        | undefined;

      const ops = opsStore.getRunEvents(runId);

      return {
        run: {
          runId: run.run_id as string,
          threadId: run.thread_id as string,
          agentId: run.agent_id as string,
          kind: run.kind as string,
          parentRunId: run.parent_run_id as string | null,
          status: run.status as string,
          traceId: origin?.traceId ?? null,
          startedAt: run.started_at as number,
          endedAt: run.ended_at as number | null,
        },
        attempts: attempts.map((a) => ({
          attemptId: a.attempt_id,
          heartbeatAt: a.heartbeat_at,
          heartbeatAgeMs: a.heartbeat_at ? Date.now() - a.heartbeat_at : null,
          startedAt: a.started_at,
          endedAt: a.ended_at,
          transport: "attached" as const,
        })),
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
      const run = db
        .query("SELECT status FROM run WHERE run_id = ?")
        .get(runId) as { status: string } | undefined;
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

    recover(runId: string): RecoverRunResult {
      const run = db
        .query("SELECT status, agent_id FROM run WHERE run_id = ?")
        .get(runId) as { status: string; agent_id: string } | undefined;
      if (!run) return { state: "already_terminal", status: "unknown" };
      if (run.status !== "running") return { state: "already_terminal", status: run.status };

      const attempt = db
        .query(
          "SELECT attempt_id, heartbeat_at FROM attempt WHERE run_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
        )
        .get(runId) as
        | { attempt_id: string; heartbeat_at: number | null }
        | undefined;

      if (!attempt) return { state: "already_terminal", status: "unknown" };

      const age = attempt.heartbeat_at ? Date.now() - attempt.heartbeat_at : Infinity;
      if (age >= heartbeatTimeoutMs) {
        const now = Date.now();
        db.transaction(() => {
          db.run("UPDATE run SET status = 'interrupted', ended_at = ? WHERE run_id = ?", [
            now,
            runId,
          ]);
          db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [
            now,
            attempt.attempt_id,
          ]);
        })();
        opsStore.appendRunEvent({
          runId,
          attemptId: attempt.attempt_id,
          kind: "recover_requested",
          payload: { reason: "heartbeat_timeout" },
        });
        return { state: "marked_interrupted", reason: "heartbeat_timeout" };
      }

      return { state: "waiting", reason: "heartbeat_fresh_but_transport_detached" };
    },

    getAgentRuntime(agentId: string): AgentRuntimeStatus | null {
      const runnerHealth = opsStore.getRunnerHealth(agentId);
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

      const runnerRow: RunnerHealthRow | undefined = runnerHealth
        ? {
            agentId: runnerHealth.agentId,
            lastSeenAt: runnerHealth.lastSeenAt,
            uptimeMs: runnerHealth.uptimeMs,
            activeRunCount: runnerHealth.activeRunCount,
            activeRunIds: runnerHealth.activeRunIds,
            checkpointerOk: runnerHealth.checkpointerOk,
            workspaceOk: runnerHealth.workspaceOk,
            lastError: runnerHealth.lastError,
            updatedAt: runnerHealth.updatedAt,
          }
        : undefined;

      return {
        agentId,
        runner: {
          status: computeRunnerStatus(runnerRow, Date.now(), OFFLINE_AFTER_MS),
          lastSeenAt: runnerHealth?.lastSeenAt ?? null,
          uptimeMs: runnerHealth?.uptimeMs ?? 0,
          activeRunCount: runnerHealth?.activeRunCount ?? 0,
          checkpointerOk: runnerHealth?.checkpointerOk === 1,
          workspaceOk: runnerHealth?.workspaceOk === 1,
          lastError: runnerHealth?.lastError ?? null,
        },
        surfaces,
      };
    },
  };
}

export type RuntimeOpsService = ReturnType<typeof createRuntimeOpsService>;
