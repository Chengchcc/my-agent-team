import { desc } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ─── run (events.db) ───────────────────────────────────────────────
// PR-6: threadId renamed to sessionId (ID#1b column migration).
export const run = sqliteTable(
  "run",
  {
    runId: text().primaryKey(),
    sessionId: text().notNull(),
    status: text().notNull().default("running"),
    kind: text().notNull().default("main"),
    parentRunId: text(),
    agentId: text().notNull().default(""),
    degradedReason: text(),
    startedAt: integer({ mode: "number" }).notNull(),
    endedAt: integer({ mode: "number" }),
  },
  (table) => [index("idx_run_thread").on(table.sessionId, desc(table.startedAt))],
);

// ─── attempt ───────────────────────────────────────────────────────
// PR-3: PK changed from attemptId to composite (runId, seq).
// attemptId column removed; seq is a run-scoped ordinal (1, 2, …).
export const attempt = sqliteTable(
  "attempt",
  {
    runId: text()
      .notNull()
      .references(() => run.runId, { onDelete: "cascade" }),
    seq: integer().notNull(),
    pid: integer(),
    heartbeatAt: integer({ mode: "number" }),
    startedAt: integer({ mode: "number" }).notNull(),
    endedAt: integer({ mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.seq] }),
    index("idx_attempt_run").on(table.runId, table.startedAt),
  ],
);

// ─── run_ops_event ─────────────────────────────────────────────────
export const runOpsEvent = sqliteTable(
  "run_ops_event",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    runId: text().notNull(),
    /** PR-3: changed from attemptId (text) to attemptSeq (integer). */
    attemptSeq: integer(),
    kind: text().notNull(),
    payload: text().notNull().default("{}"),
    traceId: text(),
    ts: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_run_ops_event_run").on(table.runId, table.seq),
    index("idx_run_ops_event_trace").on(table.traceId, table.seq),
    index("idx_run_ops_event_kind").on(table.kind, desc(table.ts)),
  ],
);

// ─── run_origin ────────────────────────────────────────────────────
export const runOrigin = sqliteTable(
  "run_origin",
  {
    runId: text().primaryKey(),
    conversationId: text().notNull(),
    sourceLedgerSeq: integer().notNull(),
    agentMemberId: text().notNull(),
    surface: text().notNull().default("web"),
    traceId: text().notNull(),
    traceparent: text().notNull(),
    idempotencyKey: text().notNull(),
    issueId: text(),
    cronJobId: text(),
    fromStatus: text().notNull().default(""),
    originKind: text().notNull().default("manual"),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_run_origin_idem").on(table.idempotencyKey),
    index("idx_run_origin_trace").on(table.traceId),
    index("idx_run_origin_issue").on(table.issueId),
    index("idx_run_origin_cron").on(table.cronJobId),
  ],
);

// ─── runner_health ─────────────────────────────────────────────────
export const runnerHealth = sqliteTable("runner_health", {
  agentId: text().primaryKey(),
  lastSeenAt: integer({ mode: "number" }),
  uptimeMs: integer({ mode: "number" }),
  activeRunCount: integer().notNull().default(0),
  activeRunIds: text().notNull().default("[]"),
  checkpointerOk: integer().notNull().default(1),
  workspaceOk: integer().notNull().default(1),
  lastError: text(),
  updatedAt: integer({ mode: "number" }).notNull(),
});

// ─── event_log ─────────────────────────────────────────────────────
export const eventLog = sqliteTable(
  "event_log",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    sessionId: text().notNull(),
    runId: text().notNull(),
    event: text().notNull(),
    ts: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_event_log_run").on(table.runId, table.seq),
    index("idx_event_log_thread").on(table.sessionId, table.seq),
  ],
);

// ─── surface_health ────────────────────────────────────────────────
export const surfaceHealth = sqliteTable(
  "surface_health",
  {
    agentId: text().notNull(),
    surface: text().notNull(),
    status: text().notNull(),
    lastSeenAt: integer({ mode: "number" }),
    payload: text().notNull().default("{}"),
    lastError: text(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.surface] })],
);

// ─── issue_event ───────────────────────────────────────────────────
export const issueEvent = sqliteTable(
  "issue_event",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    issueId: text().notNull(),
    kind: text().notNull(),
    payload: text().notNull().default("{}"),
    ts: integer({ mode: "number" }).notNull(),
  },
  (table) => [index("idx_issue_event_issue").on(table.issueId, table.seq)],
);
