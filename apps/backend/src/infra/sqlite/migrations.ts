import { SQLITE_CHECKPOINTER_MIGRATIONS } from "@my-agent-team/checkpointer-sqlite";

export const BACKEND_MIGRATIONS: readonly { id: number; up: string }[] = [
  {
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
    id: 2,
    up: `CREATE INDEX IF NOT EXISTS idx_agents_archived ON agents(archived_at)`,
  },
  {
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
    id: 4,
    up: `CREATE INDEX IF NOT EXISTS idx_threads_agent ON threads(agent_id, updated_at DESC)`,
  },
  {
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
    id: 6,
    up: `CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, started_at DESC)`,
  },
];

/** Combined migrations: backend own + checkpointer tables. Sorted by id. */
export const ALL_MIGRATIONS: readonly { id: number; up: string }[] = [
  ...BACKEND_MIGRATIONS,
  ...SQLITE_CHECKPOINTER_MIGRATIONS,
].sort((a, b) => a.id - b.id);
