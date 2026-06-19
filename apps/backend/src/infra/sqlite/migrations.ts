import { SQLITE_CHECKPOINTER_MIGRATIONS } from "@my-agent-team/framework";

/**
 * Migration naming/id convention (applies to NEW migrations only — existing
 * `name` values are the dedup key and MUST NOT be renamed):
 *   - name: `backend_v<seq>_<slug>`, seq strictly increasing by append order.
 *   - id:   strictly increasing, segment-allocated:
 *             1–999     core (agents/threads/runs)
 *             4000–4999 conversation/member/ledger
 *             5000–5999 schema alterations & repairs
 *   - Append new entries at the ARRAY END; the runner sorts by id, so array
 *     position no longer affects execution order (see db.ts).
 */

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
  {
    name: "backend_v17_ledger_run_id_column",
    id: 4003,
    up: `
      ALTER TABLE conversation_ledger ADD COLUMN run_id TEXT DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_ledger_run ON conversation_ledger(run_id) WHERE run_id IS NOT NULL`,
  },
  {
    name: "backend_v16_drop_orphan_conversations",
    id: 5002,
    up: `
      -- Repair debt from v14 composite-PK migration: some conversations lost
      -- their agent member via INSERT OR IGNORE collision. 0-member conversations
      -- are unrecoverable → delete (ledger rows cascade automatically).
      DELETE FROM conversation
      WHERE NOT EXISTS (
        SELECT 1 FROM member m WHERE m.conversation_id = conversation.conversation_id
      );
    `,
  },
  {
    name: "backend_v17_drop_threads_legacy",
    id: 5003,
    up: `
      -- M14 complete: conversation is the only user-facing concept; no live threads remain.
      -- Drop legacy backend.db run/attempt (dead tables, never queried at runtime —
      -- live run/attempt live in events.db) FIRST to clear FK to threads, then drop threads.
      DROP TABLE IF EXISTS attempt;
      DROP TABLE IF EXISTS run;
      DROP TABLE IF EXISTS threads;
    `,
  },
  // ─── M15 lark-bot agent columns (id segment 5000) ──────────
  {
    name: "backend_v18_agents_lark_enabled",
    id: 5004,
    up: `ALTER TABLE agents ADD COLUMN lark_enabled INTEGER NOT NULL DEFAULT 0`,
  },
  {
    name: "backend_v19_agents_lark_app_id",
    id: 5005,
    up: `ALTER TABLE agents ADD COLUMN lark_app_id TEXT`,
  },
  {
    name: "backend_v20_agents_lark_profile_ref",
    id: 5006,
    up: `ALTER TABLE agents ADD COLUMN lark_profile_ref TEXT`,
  },
  {
    name: "backend_v21_agents_lark_bot_display_name",
    id: 5007,
    up: `ALTER TABLE agents ADD COLUMN lark_bot_display_name TEXT`,
  },
  // ─── M17.4 projection_messages — replaces checkpoint_messages ──
  {
    name: "backend_v22_projection_messages",
    id: 5008,
    up: `CREATE TABLE IF NOT EXISTS projection_messages (
      thread_id  TEXT NOT NULL,
      messages   TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id)
    );
    -- Migrate existing data from the old checkpoint_messages table (if any)
    INSERT OR IGNORE INTO projection_messages
      SELECT thread_id, messages, COALESCE(updated_at, 0) FROM checkpoint_messages
      WHERE true
      ON CONFLICT(thread_id) DO NOTHING;
    DROP TABLE IF EXISTS checkpoint_messages;`,
  },
  // ─── M18.1 issue — new domain entity table ──
  // 5000 段注释虽写"schema alterations & repairs"，但 backend_v22_projection_messages(id 5008)
  // 已在此段建新表，故 Issue 用 5009 有先例；不要选 4000 段（那是 conversation/member/ledger 专段）。
  {
    name: "backend_v23_issue",
    id: 5009,
    up: `CREATE TABLE IF NOT EXISTS issue (
      issue_id   TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title      TEXT NOT NULL,
      status     TEXT NOT NULL,
      thread_id  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_issue_project ON issue(project_id);
    CREATE INDEX IF NOT EXISTS idx_issue_status  ON issue(status);`,
  },
  // ─── M18.3 project — managed entity for Issue's project_id ──
  {
    name: "backend_v24_project",
    id: 5010,
    up: `CREATE TABLE IF NOT EXISTS project (
      project_id     TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      repo_url       TEXT,
      default_branch TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_name ON project(name);`,
  },
  // ─── M18.4 column_config — per-Project per-status execution config ──
  {
    name: "backend_v25_column_config",
    id: 5011,
    up: `CREATE TABLE IF NOT EXISTS column_config (
      config_id       TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      status          TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_column_config_proj_status ON column_config(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_column_config_project ON column_config(project_id);`,
  },
];

/** Combined migrations: backend own + checkpointer (creates checkpoint_messages which
 *  is then migrated to projection_messages by backend_v22_projection_messages).
 *  M17.4: Once all existing installs have run v22, the checkpointer migrations
 *  can be removed from this list (new installs will get projection_messages directly). */
export const ALL_MIGRATIONS: readonly { name: string; id: number; up: string }[] = [
  ...BACKEND_MIGRATIONS,
  ...SQLITE_CHECKPOINTER_MIGRATIONS,
];
