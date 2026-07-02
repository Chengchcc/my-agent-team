import { desc, sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ─── agents ────────────────────────────────────────────────────────
export const agents = sqliteTable(
  "agents",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    template: text(),
    workspacePath: text().notNull().unique(),
    modelProvider: text().notNull(),
    modelName: text().notNull(),
    modelBaseUrl: text(),
    permissionMode: text().notNull().default("ask"),
    maxSteps: integer(),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
    archivedAt: integer({ mode: "number" }),
    larkEnabled: integer().notNull().default(0),
    larkAppId: text(),
    larkProfileRef: text(),
    larkBotDisplayName: text(),
  },
  (table) => [index("idx_agents_archived").on(table.archivedAt)],
);

// ─── conversation ──────────────────────────────────────────────────
export const conversation = sqliteTable("conversation", {
  conversationId: text().primaryKey(),
  triggerMode: text().notNull().default("mention"),
  hopCount: integer().notNull().default(0),
  title: text(),
  origin: text().notNull().default("user"),
  createdAt: integer({ mode: "number" }).notNull(),
});

// ─── member ────────────────────────────────────────────────────────
export const member = sqliteTable(
  "member",
  {
    memberId: text().notNull(),
    conversationId: text()
      .notNull()
      .references(() => conversation.conversationId, { onDelete: "cascade" }),
    kind: text().notNull(),
    agentId: text(),
    userRef: text(),
    displayName: text(),
    joinedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.memberId] }),
    index("idx_member_conv").on(table.conversationId),
  ],
);

// ─── conversation_ledger ───────────────────────────────────────────
export const conversationLedger = sqliteTable(
  "conversation_ledger",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    conversationId: text()
      .notNull()
      .references(() => conversation.conversationId, { onDelete: "cascade" }),
    senderMemberId: text().notNull(),
    addressedTo: text().notNull().default("[]"),
    kind: text().notNull(),
    content: text().notNull(),
    ts: integer({ mode: "number" }).notNull(),
    spanId: text("span_id"),
  },
  (table) => [
    index("idx_ledger_conv").on(table.conversationId, table.seq),
    index("idx_ledger_run").on(table.spanId).where(sql`span_id IS NOT NULL`),
  ],
);

// projection_messages table removed — redundant third copy of messages.
// Canonical stores: conversation_ledger (product truth) + checkpoint_messages (framework working state).

// ─── issue ─────────────────────────────────────────────────────────
// NOTE: project_id and session_id are bare TEXT — no FK constraint.
// PR-6: threadId renamed to sessionId (ID#1b).
export const issue = sqliteTable(
  "issue",
  {
    issueId: text().primaryKey(),
    projectId: text().notNull(),
    title: text().notNull(),
    status: text().notNull(),
    sessionId: text().notNull(),
    description: text().notNull().default(""),
    priority: text().notNull().default("P2"),
    estimatedCompletionAt: integer({ mode: "number" }),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_issue_project").on(table.projectId),
    index("idx_issue_status").on(table.status),
  ],
);

// ─── project ───────────────────────────────────────────────────────
export const project = sqliteTable(
  "project",
  {
    projectId: text().primaryKey(),
    name: text().notNull(),
    repoUrl: text(),
    defaultBranch: text(),
    autoOrchestrate: integer().notNull().default(0),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("idx_project_name").on(table.name)],
);

// ─── column_config ─────────────────────────────────────────────────
export const columnConfig = sqliteTable(
  "column_config",
  {
    configId: text().primaryKey(),
    projectId: text().notNull(),
    status: text().notNull(),
    agentId: text().notNull(),
    promptTemplate: text().notNull(),
    approvalPosture: text().notNull().default("auto"),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_column_config_proj_status").on(table.projectId, table.status),
    index("idx_column_config_project").on(table.projectId),
  ],
);

// ─── cron_job (M21) ──────────────────────────────────────────────
export const cronJob = sqliteTable(
  "cron_job",
  {
    cronJobId: text().primaryKey(),
    name: text().notNull(),
    agentId: text().notNull(),
    cronExpr: text().notNull(),
    prompt: text().notNull().default(""),
    enabled: integer().notNull().default(0),
    timeoutMs: integer({ mode: "number" }).notNull().default(0),
    maxRetries: integer({ mode: "number" }).notNull().default(0),
    loopConfigPath: text("loop_config_path"),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [index("idx_cron_job_enabled").on(table.enabled)],
);

// ─── deliverable ───────────────────────────────────────────────────
export const deliverable = sqliteTable(
  "deliverable",
  {
    deliverableId: text().primaryKey(),
    issueId: text().notNull(),
    fromStatus: text().notNull(),
    kind: text().notNull(),
    fields: text().notNull(),
    ref: text(),
    spanId: text("span_id"),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_deliverable_issue").on(table.issueId),
    index("idx_deliverable_issue_kind").on(table.issueId, table.kind),
    uniqueIndex("idx_deliverable_run_kind")
      .on(table.spanId, table.kind)
      .where(sql`span_id IS NOT NULL`),
  ],
);

// ── Execution-related tables (merged into single-db under S1 storage convergence) ──

export const run = sqliteTable(
  "run",
  {
    spanId: text().primaryKey(),
    sessionId: text().notNull(),
    status: text().notNull().default("running"),
    kind: text().notNull().default("main"),
    parentSpanId: text("parent_span_id"),
    agentId: text().notNull().default(""),
    degradedReason: text(),
    startedAt: integer({ mode: "number" }).notNull(),
    endedAt: integer({ mode: "number" }),
  },
  (table) => [index("idx_run_session").on(table.sessionId, desc(table.startedAt))],
);

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

// S4: run_ops_event → control_plane_event rename
export const controlPlaneEvent = sqliteTable(
  "control_plane_event",
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
    index("idx_control_plane_event_span").on(table.spanId, table.seq),
    index("idx_control_plane_event_trace").on(table.traceId, table.seq),
    index("idx_control_plane_event_kind").on(table.kind, desc(table.ts)),
  ],
);

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

// ─── skill_pack ─────────────────────────────────────────────────────────
export const skillPack = sqliteTable(
  "skill_pack",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text().notNull(),
    sourceKind: text().notNull(),
    sourceUrl: text(),
    versionRef: text(),
    installedRef: text(),
    status: text().notNull(),
    error: text(),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [index("idx_skill_pack_status").on(table.status)],
);

// ─── agent_skill_pack ────────────────────────────────────────────────────
export const agentSkillPack = sqliteTable(
  "agent_skill_pack",
  {
    agentId: text().notNull(),
    packId: text().notNull(),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.packId] })],
);

// ── Zod schemas (type chain: drizzle table → Zod → z.infer → TS type) ──

import { createSelectSchema } from "drizzle-zod";

// ── Simple tables (drizzle-zod auto-generate) ──

export const runOriginSelectSchema = createSelectSchema(runOrigin);
export const issueSelectSchema = createSelectSchema(issue, {
  status: (s) =>
    s.transform((v) => v as "draft" | "planned" | "in_progress" | "in_review" | "done"),
  priority: (s) => s.transform((v) => v as "P0" | "P1" | "P2" | "P3"),
});
export const columnConfigSelectSchema = createSelectSchema(columnConfig, {
  status: (s) =>
    s.transform((v) => v as "draft" | "planned" | "in_progress" | "in_review" | "done"),
  approvalPosture: (s) => s.transform((v) => v as "auto" | "human"),
});
export const agentsSelectSchema = createSelectSchema(agents, {
  larkEnabled: (s) => s.transform((v: number) => v !== 0),
  permissionMode: (s) => s.transform((v) => v as "ask" | "auto" | "deny"),
});
export const conversationSelectSchema = createSelectSchema(conversation);
export const memberSelectSchema = createSelectSchema(member);
export const skillPackSelectSchema = createSelectSchema(skillPack, {
  sourceKind: (s) => s.transform((v) => v as "builtin" | "git" | "zip"),
  status: (s) => s.transform((v) => v as "pending" | "installing" | "ready" | "failed" | "syncing"),
});
export const agentSkillPackSelectSchema = createSelectSchema(agentSkillPack);

// ── Tables with JSON/bool columns — drizzle-zod refine callback pattern ──
// callback (schema) => schema.transform(...) adds transforms while preserving drizzle-zod types

export const controlPlaneEventSelectSchema = createSelectSchema(controlPlaneEvent, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const surfaceHealthSelectSchema = createSelectSchema(surfaceHealth, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const issueEventSelectSchema = createSelectSchema(issueEvent, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const deliverableSelectSchema = createSelectSchema(deliverable, {
  fields: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, string>),
});

export const conversationLedgerSelectSchema = createSelectSchema(conversationLedger, {
  addressedTo: (s) => s.transform((v: string) => JSON.parse(v) as string[]),
  content: (s) => s.transform((v: string) => JSON.parse(v) as unknown),
});

export const projectSelectSchema = createSelectSchema(project, {
  autoOrchestrate: (s) => s.transform((v: number) => v !== 0),
});

export const cronJobSelectSchema = createSelectSchema(cronJob, {
  enabled: (s) => s.transform((v: number) => v !== 0),
});

/** Convert boolean to 0|1 for integer columns. Single source of truth
 *  for the bool→int conversion used by adapters. */
export const boolToInt = (v: boolean): number => (v ? 1 : 0);
// must satisfy IssueRow, so any drizzle column drift fails tsc at the adapter.
