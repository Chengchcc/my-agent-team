import type { Database } from "bun:sqlite";
import type { CheckpointEvent, CheckpointEventRow } from "@my-agent-team/framework";

/** Lightweight type guard: validates that a parsed JSON value has the shape
 *  of a CheckpointEvent (discriminated union on `type`). */
function isCheckpointEvent(v: unknown): v is CheckpointEvent {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.type === "string" && [
    "user_input", "model_start", "model_end", "tool_start", "tool_end",
    "interrupt", "resume", "run_end", "force_continue",
  ].includes(obj.type);
}

/** Read-only accessor for checkpoint_events in checkpointer.db.
 *  Run-loop is the writer; Ops is the reader — same physical table, normal infra sharing. */
export interface CheckpointEventsStore {
  /** All fact events for a single span (prompt loop). */
  readBySpan(sessionId: string, spanId: string): CheckpointEventRow[];
  /** All fact events for a session (across spans). */
  readBySession(sessionId: string): CheckpointEventRow[];
  /** Time-window scan for monitoring summaries. */
  readWindow(from: number, to: number): CheckpointEventRow[];
}

export function createCheckpointEventsStore(db: Database): CheckpointEventsStore {
  // WAL mode is set and persisted by the framework checkpointer (the writer).
  // This store opens the DB readonly — executing write PRAGMAs would throw SQLITE_READONLY.
  // The checkpointer.db schema is managed by framework's ensureCheckpointerSchema.
  // We just open a read-only connection.

  function parseRows(
    rows: Array<{
      event: string;
      span_id: string | null;
      ts: number;
      session_id: string;
    }>,
  ): CheckpointEventRow[] {
    return rows
      .map((r) => {
        try {
          const raw = JSON.parse(r.event) as unknown;
          if (!isCheckpointEvent(raw)) return null;
          return {
            ...raw,
            spanId: r.span_id,
            ts: r.ts,
            sessionId: r.session_id,
          } as CheckpointEventRow & { sessionId: string };
        } catch {
          return null;
        }
      })
      .filter((r): r is CheckpointEventRow & { sessionId: string } => r !== null);
  }

  return {
    readBySpan(sessionId: string, spanId: string): CheckpointEventRow[] {
      const rows = db
        .query(
          `SELECT event, span_id, ts, session_id
           FROM checkpoint_events
           WHERE session_id = ? AND span_id = ?
           ORDER BY id`,
        )
        .all(sessionId, spanId) as Array<{
        event: string;
        span_id: string | null;
        ts: number;
        session_id: string;
      }>;
      return parseRows(rows);
    },

    readBySession(sessionId: string): CheckpointEventRow[] {
      const rows = db
        .query(
          `SELECT event, span_id, ts, session_id
           FROM checkpoint_events
           WHERE session_id = ?
           ORDER BY id`,
        )
        .all(sessionId) as Array<{
        event: string;
        span_id: string | null;
        ts: number;
        session_id: string;
      }>;
      return parseRows(rows);
    },

    readWindow(from: number, to: number): CheckpointEventRow[] {
      const rows = db
        .query(
          `SELECT event, span_id, ts, session_id
           FROM checkpoint_events
           WHERE ts >= ? AND ts <= ?
           ORDER BY id`,
        )
        .all(from, to) as Array<{
        event: string;
        span_id: string | null;
        ts: number;
        session_id: string;
      }>;
      return parseRows(rows);
    },
  };
}
