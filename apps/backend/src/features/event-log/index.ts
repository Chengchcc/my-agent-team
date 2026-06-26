import { Database as SqliteDatabase } from "bun:sqlite";
import type { AgentEvent } from "@my-agent-team/framework";
import { safeParseAgentEvent } from "@my-agent-team/framework";
import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/events-schema.js";

// -- Types --

export interface EventRecord {
  seq: number;
  sessionId: string;
  runId: string;
  event: AgentEvent;
  ts: number;
}

export interface ReadQuery {
  runId?: string;
  sessionId?: string;
  afterSeq?: number;
  limit?: number;
}

export interface SubscribeOptions {
  pollMs?: number;
}

export const DEFAULT_POLL_MS = 250;

/** Write side: event producers (run subprocess). Only append. */
export interface EventSink {
  append(sessionId: string, runId: string, event: AgentEvent): Promise<number>;
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

// -- DDL safety-net (canonical DDL is managed by drizzle-kit baseline) --

const DDL_SAFETY_NET = `
CREATE TABLE IF NOT EXISTS event_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  event      TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_run    ON event_log(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_event_log_thread ON event_log(session_id, seq);
`;

// -- SQLite --

function openDatabase(db: SqliteDatabase | string): SqliteDatabase {
  if (typeof db === "string") return new SqliteDatabase(db);
  return db;
}

function toEventRecord(r: typeof schema.eventLog.$inferSelect): EventRecord | null {
  const result = safeParseAgentEvent(JSON.parse(r.event));
  if (!result.success) {
    console.warn(
      `[event-log] skipping unparseable event seq=${r.seq}: ${result.error.issues[0]?.message}`,
    );
    return null;
  }
  return {
    seq: r.seq,
    sessionId: r.sessionId,
    runId: r.runId,
    event: result.data,
    ts: r.ts,
  };
}

export function sqliteEventLog(opts: { db: SqliteDatabase | string }): EventLog {
  const db = openDatabase(opts.db);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  // M20: Canonical DDL is managed by drizzle-kit (events_v11_event_log baseline).
  // Safety-net for standalone/test use (in-memory DBs bypass the main migration path).
  db.exec(DDL_SAFETY_NET);

  const d = drizzle(db, { schema, casing: "snake_case" });

  const sink: EventSink = {
    async append(sessionId: string, runId: string, event: AgentEvent): Promise<number> {
      const ts = Date.now();
      const json = JSON.stringify(event);
      const row = d
        .insert(schema.eventLog)
        .values({ sessionId, runId, event: json, ts })
        .returning({ seq: schema.eventLog.seq })
        .get();
      return row!.seq;
    },
  };

  const source: EventSource = {
    async read(query: ReadQuery): Promise<EventRecord[]> {
      const conditions = [];
      if (query.runId) conditions.push(eq(schema.eventLog.runId, query.runId));
      if (query.sessionId) conditions.push(eq(schema.eventLog.sessionId, query.sessionId));
      if (query.afterSeq !== undefined) {
        conditions.push(gt(schema.eventLog.seq, query.afterSeq));
      }
      let q = d.select().from(schema.eventLog).orderBy(schema.eventLog.seq).$dynamic();
      if (conditions.length > 0) q = q.where(and(...conditions));
      if (query.limit) q = q.limit(query.limit);
      return (q.all() as (typeof schema.eventLog.$inferSelect)[])
        .map(toEventRecord)
        .filter((r): r is EventRecord => r !== null);
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
    async append(sessionId: string, runId: string, event: AgentEvent): Promise<number> {
      const seq = nextSeq++;
      const rec: EventRecord = { seq, sessionId, runId, event, ts: Date.now() };
      records.push(rec);
      for (const fn of listeners) fn(rec);
      return seq;
    },
  };

  const source: EventSource = {
    async read(query: ReadQuery): Promise<EventRecord[]> {
      let result = [...records];
      if (query.runId) result = result.filter((r) => r.runId === query.runId);
      if (query.sessionId) result = result.filter((r) => r.sessionId === query.sessionId);
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
