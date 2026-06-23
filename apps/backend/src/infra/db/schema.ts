import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    runId: text(),
  },
  (table) => [
    index("idx_ledger_conv").on(table.conversationId, table.seq),
    index("idx_ledger_run")
      .on(table.runId)
      .where(sql`run_id IS NOT NULL`),
  ],
);

// ─── projection_messages ───────────────────────────────────────────
export const projectionMessages = sqliteTable("projection_messages", {
  threadId: text().primaryKey(),
  messages: text().notNull(),
  updatedAt: integer({ mode: "number" }).notNull(),
});

// ─── issue ─────────────────────────────────────────────────────────
// NOTE: project_id and thread_id are bare TEXT — no FK constraint.
export const issue = sqliteTable(
  "issue",
  {
    issueId: text().primaryKey(),
    projectId: text().notNull(),
    title: text().notNull(),
    status: text().notNull(),
    threadId: text().notNull(),
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
    runId: text(),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_deliverable_issue").on(table.issueId),
    index("idx_deliverable_issue_kind").on(table.issueId, table.kind),
    uniqueIndex("idx_deliverable_run_kind")
      .on(table.runId, table.kind)
      .where(sql`run_id IS NOT NULL`),
  ],
);
