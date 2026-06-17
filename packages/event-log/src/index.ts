import type { SQLQueryBindings, Database as SqliteDatabase } from "bun:sqlite";
import type { AgentEvent } from "@my-agent-team/framework";
import { parseAgentEvent } from "@my-agent-team/framework";

// -- Types --

export interface EventRecord {
  seq: number;
  threadId: string;
  runId: string;
  event: AgentEvent;
  ts: number;
}

export interface ReadQuery {
  runId?: string;
  threadId?: string;
  afterSeq?: number;
  limit?: number;
}

export interface SubscribeOptions {
  pollMs?: number;
}

export const DEFAULT_POLL_MS = 250;

/** Write side: event producers (run subprocess). Only append. */
export interface EventSink {
  append(threadId: string, runId: string, event: AgentEvent): Promise<number>;
}

/** Read side: event projectors (backend SSE / audit / replay). Only read. */
export interface EventSource {
  read(query: ReadQuery): Promise<EventRecord[]>;
  subscribe(
    query: ReadQuery,
    opts?: SubscribeOptions,
    signal?: AbortSignal,
  ): AsyncIterable<EventRecord>;
}

export interface EventLog extends EventSink, EventSource {}

// -- Migrations --

const EVENT_LOG_DDL = `
CREATE TABLE IF NOT EXISTS event_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  event      TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_run    ON event_log(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_event_log_thread ON event_log(thread_id, seq);
`;

export const EVENT_LOG_MIGRATIONS = [
  { id: 2000, name: "event_log_v1_event_log", up: EVENT_LOG_DDL },
] as const;

// -- SQLite --

function openDatabase(db: SqliteDatabase | string): SqliteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as { Database: typeof SqliteDatabase };
  if (typeof db === "string") return new Database(db);
  return db;
}

function buildWhere(query: ReadQuery): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (query.runId) {
    conds.push("run_id = ?");
    params.push(query.runId);
  }
  if (query.threadId) {
    conds.push("thread_id = ?");
    params.push(query.threadId);
  }
  if (query.afterSeq !== undefined) {
    conds.push("seq > ?");
    params.push(query.afterSeq);
  }
  const clause = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  return { clause, params };
}

function mapRow(row: {
  seq: number;
  thread_id: string;
  run_id: string;
  event: string;
  ts: number;
}): EventRecord {
  return {
    seq: row.seq,
    threadId: row.thread_id,
    runId: row.run_id,
    event: parseAgentEvent(JSON.parse(row.event)),
    ts: row.ts,
  };
}

export function sqliteEventLog(opts: { db: SqliteDatabase | string }): EventLog {
  const db = openDatabase(opts.db);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(EVENT_LOG_DDL);

  const sink: EventSink = {
    async append(threadId: string, runId: string, event: AgentEvent): Promise<number> {
      const ts = Date.now();
      const json = JSON.stringify(event);
      const result = db.run(
        "INSERT INTO event_log (thread_id, run_id, event, ts) VALUES (?, ?, ?, ?)",
        [threadId, runId, json, ts],
      );
      return Number(result.lastInsertRowid);
    },
  };

  const source: EventSource = {
    async read(query: ReadQuery): Promise<EventRecord[]> {
      const { clause, params } = buildWhere(query);
      const limit = query.limit ? `LIMIT ${query.limit}` : "";
      return (
        db
          .query(
            `SELECT seq, thread_id, run_id, event, ts FROM event_log ${clause} ORDER BY seq ASC ${limit}`,
          )
          .all(...(params as SQLQueryBindings[])) as {
          seq: number;
          thread_id: string;
          run_id: string;
          event: string;
          ts: number;
        }[]
      ).map(mapRow);
    },

    async *subscribe(
      query: ReadQuery,
      opts?: SubscribeOptions,
      signal?: AbortSignal,
    ): AsyncIterable<EventRecord> {
      const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
      let lastSeq = query.afterSeq ?? 0;

      // Phase 1: replay history
      const historical = await this.read({ ...query, afterSeq: lastSeq });
      for (const rec of historical) {
        if (signal?.aborted) return;
        yield rec;
        lastSeq = Math.max(lastSeq, rec.seq);
      }

      // Phase 2: tail poll
      while (!signal?.aborted) {
        const rows = await this.read({ ...query, afterSeq: lastSeq });
        for (const rec of rows) {
          if (signal?.aborted) return;
          yield rec;
          lastSeq = Math.max(lastSeq, rec.seq);
        }
        if (rows.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      }
    },
  };

  return { ...sink, ...source };
}

// -- In-Memory --

export function inMemoryEventLog(): EventLog {
  const records: EventRecord[] = [];
  let nextSeq = 1;
  let listeners: Array<(rec: EventRecord) => void> = [];

  const sink: EventSink = {
    async append(threadId: string, runId: string, event: AgentEvent): Promise<number> {
      const seq = nextSeq++;
      const rec: EventRecord = { seq, threadId, runId, event, ts: Date.now() };
      records.push(rec);
      for (const fn of listeners) fn(rec);
      return seq;
    },
  };

  const source: EventSource = {
    async read(query: ReadQuery): Promise<EventRecord[]> {
      let result = [...records];
      if (query.runId) result = result.filter((r) => r.runId === query.runId);
      if (query.threadId) result = result.filter((r) => r.threadId === query.threadId);
      if (query.afterSeq !== undefined) result = result.filter((r) => r.seq > query.afterSeq!);
      if (query.limit) result = result.slice(0, query.limit);
      return result;
    },

    async *subscribe(
      query: ReadQuery,
      opts?: SubscribeOptions,
      signal?: AbortSignal,
    ): AsyncIterable<EventRecord> {
      const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
      let lastSeq = query.afterSeq ?? 0;

      // Phase 1: replay history
      for (const rec of await this.read({ ...query, afterSeq: lastSeq })) {
        if (signal?.aborted) return;
        yield rec;
        lastSeq = Math.max(lastSeq, rec.seq);
      }

      // Phase 2: listen for new events with polling fallback
      let woken = false; // eslint-disable-line no-useless-assignment
      const listener = (_rec: EventRecord) => {
        woken = true;
      };
      listeners.push(listener);

      try {
        while (!signal?.aborted) {
          const newRecs = await this.read({ ...query, afterSeq: lastSeq });
          for (const rec of newRecs) {
            if (signal?.aborted) return;
            yield rec;
            lastSeq = Math.max(lastSeq, rec.seq);
          }
          if (newRecs.length === 0) {
            woken = false;
            // Wait with polling fallback
            const start = Date.now();
            while (!woken && !signal?.aborted && Date.now() - start < pollMs) {
              await new Promise((r) => setTimeout(r, 10));
            }
          }
        }
      } finally {
        listeners = listeners.filter((l) => l !== listener);
      }
    },
  };

  return { ...sink, ...source };
}
