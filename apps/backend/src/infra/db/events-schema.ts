import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── run (events.db) ───────────────────────────────────────────────
export const run = sqliteTable(
  "run",
  {
    runId: text("run_id").primaryKey(),
    threadId: text("thread_id").notNull(),
    status: text("status").notNull().default("running"),
    kind: text("kind").notNull().default("main"),
    parentRunId: text("parent_run_id"),
    agentId: text("agent_id").notNull().default(""),
    degradedReason: text("degraded_reason"),
    startedAt: integer("started_at", { mode: "number" }).notNull(),
    endedAt: integer("ended_at", { mode: "number" }),
  },
  (table) => [
    // DESC direction must be preserved — matches existing idx_run_thread
    index("idx_run_thread").on(table.threadId, table.startedAt),
  ],
);

// ─── attempt ───────────────────────────────────────────────────────
export const attempt = sqliteTable(
  "attempt",
  {
    attemptId: text("attempt_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => run.runId, { onDelete: "cascade" }),
    pid: integer("pid"),
    heartbeatAt: integer("heartbeat_at", { mode: "number" }),
    startedAt: integer("started_at", { mode: "number" }).notNull(),
    endedAt: integer("ended_at", { mode: "number" }),
  },
  (table) => [index("idx_attempt_run").on(table.runId, table.startedAt)],
);

// ─── run_ops_event ─────────────────────────────────────────────────
export const runOpsEvent = sqliteTable(
  "run_ops_event",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id"),
    kind: text("kind").notNull(),
    payload: text("payload").notNull().default("{}"),
    traceId: text("trace_id"),
    ts: integer("ts", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_run_ops_event_run").on(table.runId, table.seq),
    index("idx_run_ops_event_trace").on(table.traceId, table.seq),
    // DESC direction must be preserved
    index("idx_run_ops_event_kind").on(table.kind, table.ts),
  ],
);

// ─── run_origin ────────────────────────────────────────────────────
export const runOrigin = sqliteTable(
  "run_origin",
  {
    runId: text("run_id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sourceLedgerSeq: integer("source_ledger_seq").notNull(),
    agentMemberId: text("agent_member_id").notNull(),
    surface: text("surface").notNull().default("web"),
    traceId: text("trace_id").notNull(),
    traceparent: text("traceparent").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    issueId: text("issue_id"),
    fromStatus: text("from_status").notNull().default(""),
    originKind: text("origin_kind").notNull().default("manual"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_run_origin_idem").on(table.idempotencyKey),
    index("idx_run_origin_trace").on(table.traceId),
    index("idx_run_origin_issue").on(table.issueId),
  ],
);

// ─── runner_health ─────────────────────────────────────────────────
export const runnerHealth = sqliteTable("runner_health", {
  agentId: text("agent_id").primaryKey(),
  lastSeenAt: integer("last_seen_at", { mode: "number" }),
  uptimeMs: integer("uptime_ms", { mode: "number" }),
  activeRunCount: integer("active_run_count").notNull().default(0),
  activeRunIds: text("active_run_ids").notNull().default("[]"),
  checkpointerOk: integer("checkpointer_ok").notNull().default(1),
  workspaceOk: integer("workspace_ok").notNull().default(1),
  lastError: text("last_error"),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

// ─── event_log ─────────────────────────────────────────────────────
export const eventLog = sqliteTable(
  "event_log",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    threadId: text("thread_id").notNull(),
    runId: text("run_id").notNull(),
    event: text("event").notNull(),
    ts: integer("ts", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_event_log_run").on(table.runId, table.seq),
    index("idx_event_log_thread").on(table.threadId, table.seq),
  ],
);

// ─── surface_health ────────────────────────────────────────────────
export const surfaceHealth = sqliteTable(
  "surface_health",
  {
    agentId: text("agent_id").notNull(),
    surface: text("surface").notNull(),
    status: text("status").notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "number" }),
    payload: text("payload").notNull().default("{}"),
    lastError: text("last_error"),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.surface] })],
);

// ─── issue_event ───────────────────────────────────────────────────
export const issueEvent = sqliteTable(
  "issue_event",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    issueId: text("issue_id").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload").notNull().default("{}"),
    ts: integer("ts", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_issue_event_issue").on(table.issueId, table.seq)],
);
