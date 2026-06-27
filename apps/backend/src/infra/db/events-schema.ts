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
// run→span rename: TS spanId, DB span_id (snake_case casing).
// threadId→sessionId: TS sessionId, DB session_id.
export const run = sqliteTable(
  "run",
  {
    spanId: text().primaryKey(),
    sessionId: text().notNull(),
    status: text().notNull().default("running"),
    kind: text().notNull().default("main"),
    parentSpanId: text("parent_span_id"), // explicit: drizzle can't auto-name parentSpanId
    agentId: text().notNull().default(""),
    degradedReason: text(),
    startedAt: integer({ mode: "number" }).notNull(),
    endedAt: integer({ mode: "number" }),
  },
  (table) => [index("idx_run_session").on(table.sessionId, desc(table.startedAt))],
);

// ─── attempt ───────────────────────────────────────────────────────
export const attempt = sqliteTable(
  "attempt",
  {
    spanId: text()
      .notNull()
      .references(() => run.spanId, { onDelete: "cascade" }),
    seq: integer().notNull(),
    pid: integer(),
    heartbeatAt: integer({ mode: "number" }),
    startedAt: integer({ mode: "number" }).notNull(),
    endedAt: integer({ mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.spanId, table.seq] }),
    index("idx_attempt_span").on(table.spanId, table.startedAt),
  ],
);

// ─── run_ops_event ─────────────────────────────────────────────────
export const runOpsEvent = sqliteTable(
  "run_ops_event",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    spanId: text().notNull(),
    attemptSeq: integer(),
    kind: text().notNull(),
    payload: text().notNull().default("{}"),
    traceId: text(),
    ts: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_run_ops_event_span").on(table.spanId, table.seq),
    index("idx_run_ops_event_trace").on(table.traceId, table.seq),
    index("idx_run_ops_event_kind").on(table.kind, desc(table.ts)),
  ],
);

// ─── run_origin ────────────────────────────────────────────────────
export const runOrigin = sqliteTable(
  "run_origin",
  {
    spanId: text().primaryKey(),
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

// event_log table removed — execution facts now live in checkpointer.db

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
