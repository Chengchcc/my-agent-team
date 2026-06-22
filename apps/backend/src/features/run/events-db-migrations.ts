import type { Database } from "bun:sqlite";

export const EVENTS_DB_MIGRATIONS = [
  {
    name: "events_v1_run",
    id: 3000,
    up: `CREATE TABLE IF NOT EXISTS run (
      run_id     TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at   INTEGER
    )`,
  },
  {
    name: "events_v2_attempt",
    id: 3001,
    up: `CREATE TABLE IF NOT EXISTS attempt (
      attempt_id   TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
      pid          INTEGER,
      heartbeat_at INTEGER,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER
    )`,
  },
  {
    name: "events_v3_attempt_run_idx",
    id: 3002,
    up: `CREATE INDEX IF NOT EXISTS idx_attempt_run ON attempt(run_id, started_at)`,
  },
  {
    name: "events_v4_run_thread_idx",
    id: 3003,
    up: `CREATE INDEX IF NOT EXISTS idx_run_thread ON run(thread_id, started_at DESC)`,
  },
  {
    name: "events_v5_run_kind_parent",
    id: 3004,
    up: `
      ALTER TABLE run ADD COLUMN kind TEXT NOT NULL DEFAULT 'main';
      ALTER TABLE run ADD COLUMN parent_run_id TEXT;
    `,
  },
  {
    name: "events_v6_run_agent_id",
    id: 3005,
    up: `ALTER TABLE run ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''`,
  },
  {
    name: "events_v7_run_ops_event",
    id: 3006,
    up: `CREATE TABLE IF NOT EXISTS run_ops_event (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      attempt_id   TEXT,
      kind         TEXT NOT NULL,
      payload      TEXT NOT NULL DEFAULT '{}',
      trace_id     TEXT,
      ts           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_ops_event_run ON run_ops_event(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_run_ops_event_trace ON run_ops_event(trace_id, seq);
    CREATE INDEX IF NOT EXISTS idx_run_ops_event_kind ON run_ops_event(kind, ts DESC);`,
  },
  {
    name: "events_v8_run_origin",
    id: 3007,
    up: `CREATE TABLE IF NOT EXISTS run_origin (
      run_id            TEXT PRIMARY KEY,
      conversation_id   TEXT NOT NULL,
      source_ledger_seq INTEGER NOT NULL,
      agent_member_id   TEXT NOT NULL,
      surface           TEXT NOT NULL DEFAULT 'web',
      trace_id          TEXT NOT NULL,
      traceparent       TEXT NOT NULL,
      idempotency_key   TEXT NOT NULL,
      created_at        INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_origin_idem ON run_origin(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_run_origin_trace ON run_origin(trace_id);`,
  },
  {
    name: "events_v9_runner_health",
    id: 3008,
    up: `CREATE TABLE IF NOT EXISTS runner_health (
      agent_id          TEXT PRIMARY KEY,
      last_seen_at      INTEGER,
      uptime_ms         INTEGER,
      active_run_count  INTEGER NOT NULL DEFAULT 0,
      active_run_ids    TEXT NOT NULL DEFAULT '[]',
      checkpointer_ok   INTEGER NOT NULL DEFAULT 1,
      workspace_ok      INTEGER NOT NULL DEFAULT 1,
      last_error        TEXT,
      updated_at        INTEGER NOT NULL
    )`,
  },
  {
    name: "events_v11_event_log",
    id: 3010,
    up: `CREATE TABLE IF NOT EXISTS event_log (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id  TEXT NOT NULL,
      run_id     TEXT NOT NULL,
      event      TEXT NOT NULL,
      ts         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_log_run    ON event_log(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_event_log_thread ON event_log(thread_id, seq);`,
  },
  {
    name: "events_v10_surface_health",
    id: 3009,
    up: `CREATE TABLE IF NOT EXISTS surface_health (
      agent_id       TEXT NOT NULL,
      surface        TEXT NOT NULL,
      status         TEXT NOT NULL,
      last_seen_at   INTEGER,
      payload        TEXT NOT NULL DEFAULT '{}',
      last_error     TEXT,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (agent_id, surface)
    )`,
  },
  {
    name: "events_v12_run_degraded_reason",
    id: 3011,
    up: `ALTER TABLE run ADD COLUMN degraded_reason TEXT`,
  },
  {
    name: "events_v13_run_origin_issue",
    id: 3012,
    up: `ALTER TABLE run_origin ADD COLUMN issue_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_run_origin_issue ON run_origin(issue_id);`,
  },
  // ─── M18.5 R3: run_origin.from_status — authoritative source, no more split(":") ──
  {
    name: "events_v14_run_origin_from_status",
    id: 3013,
    up: `ALTER TABLE run_origin ADD COLUMN from_status TEXT NOT NULL DEFAULT '';`,
  },
  // ─── M18.7 ⑦: Issue Timeline — issue 级工作事件流（独立于 run_ops_event / ledger）──
  {
    name: "events_v15_issue_event",
    id: 3014,
    up: `CREATE TABLE IF NOT EXISTS issue_event (
      seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      kind     TEXT NOT NULL,
      payload  TEXT NOT NULL DEFAULT '{}',
      ts       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_issue_event_issue ON issue_event(issue_id, seq);`,
  },
  // ─── M19: run_origin.origin_kind — explicit run cause enum ──
  {
    name: "events_v16_run_origin_kind",
    id: 3015,
    up: `ALTER TABLE run_origin ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'manual';`,
  },
];

export function runEventsDbMigrations(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, id INTEGER NOT NULL, ran_at INTEGER NOT NULL)",
  );
  const ran = new Set(
    (db.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );
  for (const m of EVENTS_DB_MIGRATIONS) {
    if (ran.has(m.name)) continue;
    db.exec(m.up);
    db.run("INSERT INTO _migrations (name, id, ran_at) VALUES (?, ?, ?)", [
      m.name,
      m.id,
      Date.now(),
    ]);
  }
}
