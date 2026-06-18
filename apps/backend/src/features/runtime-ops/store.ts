import type { Database } from "bun:sqlite";
import type {
  RunnerHealthRow,
  RunOpsEvent,
  RunOpsEventKind,
  RunOriginRow,
  SurfaceHealthRow,
} from "./types.js";

// bun:sqlite returns column names exactly as written in SQL. Use aliases so
// rows map to our camelCase interface types without a transform layer.
const RUN_OPS_COLS = `seq, run_id AS runId, attempt_id AS attemptId, kind, payload, trace_id AS traceId, ts`;
const RUN_ORIGIN_COLS = `run_id AS runId, conversation_id AS conversationId, source_ledger_seq AS sourceLedgerSeq, agent_member_id AS agentMemberId, surface, trace_id AS traceId, traceparent, idempotency_key AS idempotencyKey, issue_id AS issueId, created_at AS createdAt`;
const RUNNER_HEALTH_COLS = `agent_id AS agentId, last_seen_at AS lastSeenAt, uptime_ms AS uptimeMs, active_run_count AS activeRunCount, active_run_ids AS activeRunIds, checkpointer_ok AS checkpointerOk, workspace_ok AS workspaceOk, last_error AS lastError, updated_at AS updatedAt`;
const SURFACE_HEALTH_COLS = `agent_id AS agentId, surface, status, last_seen_at AS lastSeenAt, payload, last_error AS lastError, updated_at AS updatedAt`;

export class RuntimeOpsStore {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  // ─── run_ops_event ───

  appendRunEvent(input: {
    runId: string;
    attemptId?: string;
    kind: RunOpsEventKind;
    traceId?: string;
    payload?: Record<string, unknown>;
  }): number {
    const now = Date.now();
    this.#db.run(
      `INSERT INTO run_ops_event (run_id, attempt_id, kind, payload, trace_id, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        input.attemptId ?? null,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        input.traceId ?? null,
        now,
      ],
    );
    const row = this.#db.query("SELECT last_insert_rowid()").get() as {
      "last_insert_rowid()": number;
    };
    return row["last_insert_rowid()"];
  }

  getRunEvents(runId: string): RunOpsEvent[] {
    return this.#db
      .query(`SELECT ${RUN_OPS_COLS} FROM run_ops_event WHERE run_id = ? ORDER BY seq`)
      .all(runId) as RunOpsEvent[];
  }

  getRunEventsByTrace(traceId: string): RunOpsEvent[] {
    return this.#db
      .query(`SELECT ${RUN_OPS_COLS} FROM run_ops_event WHERE trace_id = ? ORDER BY seq`)
      .all(traceId) as RunOpsEvent[];
  }

  // ─── run_origin ───

  insertRunOrigin(row: RunOriginRow): void {
    this.#db.run(
      `INSERT OR IGNORE INTO run_origin (run_id, conversation_id, source_ledger_seq, agent_member_id, surface, trace_id, traceparent, idempotency_key, issue_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.runId,
        row.conversationId,
        row.sourceLedgerSeq,
        row.agentMemberId,
        row.surface,
        row.traceId,
        row.traceparent,
        row.idempotencyKey,
        row.issueId ?? null,
        row.createdAt,
      ],
    );
  }

  getRunOrigin(runId: string): RunOriginRow | null {
    const row = this.#db
      .query(`SELECT ${RUN_ORIGIN_COLS} FROM run_origin WHERE run_id = ?`)
      .get(runId) as RunOriginRow | undefined;
    return row ?? null;
  }

  getRunOriginByIdempotencyKey(key: string): RunOriginRow | null {
    const row = this.#db
      .query(`SELECT ${RUN_ORIGIN_COLS} FROM run_origin WHERE idempotency_key = ?`)
      .get(key) as RunOriginRow | undefined;
    return row ?? null;
  }

  listRunOrigins(): RunOriginRow[] {
    return this.#db
      .query(`SELECT ${RUN_ORIGIN_COLS} FROM run_origin ORDER BY created_at DESC`)
      .all() as RunOriginRow[];
  }

  // ─── runner_health ───

  upsertRunnerHealth(input: {
    agentId: string;
    uptimeMs: number;
    activeRunIds: string[];
    checkpointerOk: boolean;
    workspaceOk: boolean;
    lastError?: string;
  }): void {
    const now = Date.now();
    this.#db.run(
      `INSERT INTO runner_health (agent_id, last_seen_at, uptime_ms, active_run_count, active_run_ids, checkpointer_ok, workspace_ok, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         uptime_ms = excluded.uptime_ms,
         active_run_count = excluded.active_run_count,
         active_run_ids = excluded.active_run_ids,
         checkpointer_ok = excluded.checkpointer_ok,
         workspace_ok = excluded.workspace_ok,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [
        input.agentId,
        now,
        input.uptimeMs,
        input.activeRunIds.length,
        JSON.stringify(input.activeRunIds),
        input.checkpointerOk ? 1 : 0,
        input.workspaceOk ? 1 : 0,
        input.lastError ?? null,
        now,
      ],
    );
  }

  getRunnerHealth(agentId: string): RunnerHealthRow | undefined {
    return this.#db
      .query(`SELECT ${RUNNER_HEALTH_COLS} FROM runner_health WHERE agent_id = ?`)
      .get(agentId) as RunnerHealthRow | undefined;
  }

  listRunnerHealths(): RunnerHealthRow[] {
    return this.#db
      .query(`SELECT ${RUNNER_HEALTH_COLS} FROM runner_health ORDER BY agent_id`)
      .all() as RunnerHealthRow[];
  }

  // ─── surface_health ───

  upsertSurfaceHealth(input: {
    agentId: string;
    surface: string;
    status: string;
    payload: Record<string, unknown>;
    lastError?: string;
  }): void {
    const now = Date.now();
    this.#db.run(
      `INSERT INTO surface_health (agent_id, surface, status, last_seen_at, payload, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, surface) DO UPDATE SET
         status = excluded.status,
         last_seen_at = excluded.last_seen_at,
         payload = excluded.payload,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [
        input.agentId,
        input.surface,
        input.status,
        now,
        JSON.stringify(input.payload),
        input.lastError ?? null,
        now,
      ],
    );
  }

  getSurfaceHealth(agentId: string, surface: string): SurfaceHealthRow | undefined {
    return this.#db
      .query(`SELECT ${SURFACE_HEALTH_COLS} FROM surface_health WHERE agent_id = ? AND surface = ?`)
      .get(agentId, surface) as SurfaceHealthRow | undefined;
  }

  getSurfaceHealthsForAgent(agentId: string): SurfaceHealthRow[] {
    return this.#db
      .query(`SELECT ${SURFACE_HEALTH_COLS} FROM surface_health WHERE agent_id = ?`)
      .all(agentId) as SurfaceHealthRow[];
  }

  listSurfaceHealths(): SurfaceHealthRow[] {
    return this.#db
      .query(`SELECT ${SURFACE_HEALTH_COLS} FROM surface_health ORDER BY agent_id, surface`)
      .all() as SurfaceHealthRow[];
  }
}
