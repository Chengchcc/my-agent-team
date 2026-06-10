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
  // ─── M10 conversation tables (id segment 4000) ────────────────
  {
    name: "backend_v10_conversation",
    id: 4000,
    up: `CREATE TABLE IF NOT EXISTS conversation (
      conversation_id TEXT PRIMARY KEY,
      trigger_mode    TEXT NOT NULL DEFAULT 'mention',
      hop_count       INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    )`,
  },
  {
    name: "backend_v10_member",
    id: 4001,
    up: `CREATE TABLE IF NOT EXISTS member (
      member_id       TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversation(conversation_id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      agent_id        TEXT,
      user_ref        TEXT,
      display_name    TEXT,
      joined_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_member_conv ON member(conversation_id)`,
  },
  {
    name: "backend_v15_conversation_title",
    id: 5001,
    up: `ALTER TABLE conversation ADD COLUMN title TEXT`,
  },
  {
    name: "backend_v14_member_composite_pk",
    id: 5000,
    up: `
      -- member_id must be unique per-conversation, not globally.
      -- An agent (member_id = agent_id) can belong to multiple conversations.
      CREATE TABLE IF NOT EXISTS member_new (
        member_id       TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversation(conversation_id) ON DELETE CASCADE,
        kind            TEXT NOT NULL,
        agent_id        TEXT,
        user_ref        TEXT,
        display_name    TEXT,
        joined_at       INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, member_id)
      );
      INSERT OR IGNORE INTO member_new SELECT * FROM member;
      DROP TABLE IF EXISTS member;
      ALTER TABLE member_new RENAME TO member;
      CREATE INDEX IF NOT EXISTS idx_member_conv ON member(conversation_id);
    `,
  },
  {
    name: "backend_v10_conversation_ledger",
    id: 4002,
    up: `CREATE TABLE IF NOT EXISTS conversation_ledger (
      seq              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id  TEXT NOT NULL REFERENCES conversation(conversation_id) ON DELETE CASCADE,
      sender_member_id TEXT NOT NULL,
      addressed_to     TEXT NOT NULL DEFAULT '[]',
      kind             TEXT NOT NULL,
      content          TEXT NOT NULL,
      ts               INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_conv ON conversation_ledger(conversation_id, seq)`,
  },
];

/** Combined migrations: backend own + checkpointer tables. Sorted by id. */
export const ALL_MIGRATIONS: readonly { name: string; id: number; up: string }[] = [
  ...BACKEND_MIGRATIONS,
  ...SQLITE_CHECKPOINTER_MIGRATIONS,
];
