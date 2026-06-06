import { SQLITE_CHECKPOINTER_MIGRATIONS } from "@my-agent-team/checkpointer-sqlite";

export const BACKEND_MIGRATIONS: readonly { name: string; id: number; up: string }[] = [
  {
    name: "backend_v1_agents",
    id: 1,
    up: `CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  template        TEXT,
  workspace_path  TEXT NOT NULL UNIQUE,
  model_provider  TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  model_base_url  TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  max_steps       INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  archived_at     INTEGER
)`,
  },
  {
    name: "backend_v2_agents_archive_idx",
    id: 2,
    up: `CREATE INDEX IF NOT EXISTS idx_agents_archived ON agents(archived_at)`,
  },
  {
    name: "backend_v3_threads",
    id: 3,
    up: `CREATE TABLE IF NOT EXISTS threads (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title         TEXT,
  kind          TEXT NOT NULL DEFAULT 'conversation',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_run_at   INTEGER
)`,
  },
  {
    name: "backend_v4_threads_agent_idx",
    id: 4,
    up: `CREATE INDEX IF NOT EXISTS idx_threads_agent ON threads(agent_id, updated_at DESC)`,
  },
  {
    name: "backend_v5_runs",
    id: 5,
    up: `CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  input         TEXT NOT NULL,
  status        TEXT NOT NULL,
  error_message TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER
)`,
  },
  {
    name: "backend_v6_runs_thread_idx",
    id: 6,
    up: `CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, started_at DESC)`,
  },
  {
    name: "backend_v7_run_attempt_split",
    id: 7,
    up: `
      DROP TABLE IF EXISTS runs;
      CREATE TABLE run (
        run_id     TEXT PRIMARY KEY,
        thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status     TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL,
        ended_at   INTEGER
      );
      CREATE TABLE attempt (
        attempt_id   TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
        pid          INTEGER,
        heartbeat_at INTEGER,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_attempt_run ON attempt(run_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_run_thread ON run(thread_id, started_at DESC);
    `,
  },
];

/** Combined migrations: backend own + checkpointer tables. Sorted by id. */
export const ALL_MIGRATIONS: readonly { name: string; id: number; up: string }[] = [
  ...BACKEND_MIGRATIONS,
  ...SQLITE_CHECKPOINTER_MIGRATIONS,
];
