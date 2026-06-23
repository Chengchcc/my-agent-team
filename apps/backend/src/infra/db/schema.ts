import { sql } from "drizzle-orm";
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
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    template: text("template"),
    workspacePath: text("workspace_path").notNull().unique(),
    modelProvider: text("model_provider").notNull(),
    modelName: text("model_name").notNull(),
    modelBaseUrl: text("model_base_url"),
    permissionMode: text("permission_mode").notNull().default("ask"),
    maxSteps: integer("max_steps"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    archivedAt: integer("archived_at", { mode: "number" }),
    larkEnabled: integer("lark_enabled").notNull().default(0),
    larkAppId: text("lark_app_id"),
    larkProfileRef: text("lark_profile_ref"),
    larkBotDisplayName: text("lark_bot_display_name"),
  },
  (table) => [index("idx_agents_archived").on(table.archivedAt)],
);

// ─── conversation ──────────────────────────────────────────────────
export const conversation = sqliteTable("conversation", {
  conversationId: text("conversation_id").primaryKey(),
  triggerMode: text("trigger_mode").notNull().default("mention"),
  hopCount: integer("hop_count").notNull().default(0),
  title: text("title"),
  origin: text("origin").notNull().default("user"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

// ─── member ────────────────────────────────────────────────────────
export const member = sqliteTable(
  "member",
  {
    memberId: text("member_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.conversationId, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    agentId: text("agent_id"),
    userRef: text("user_ref"),
    displayName: text("display_name"),
    joinedAt: integer("joined_at", { mode: "number" }).notNull(),
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
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.conversationId, { onDelete: "cascade" }),
    senderMemberId: text("sender_member_id").notNull(),
    addressedTo: text("addressed_to").notNull().default("[]"),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    ts: integer("ts", { mode: "number" }).notNull(),
    runId: text("run_id"),
  },
  (table) => [
    index("idx_ledger_conv").on(table.conversationId, table.seq),
    index("idx_ledger_run").on(table.runId).where(sql`run_id IS NOT NULL`),
  ],
);

// ─── projection_messages ───────────────────────────────────────────
export const projectionMessages = sqliteTable("projection_messages", {
  threadId: text("thread_id").primaryKey(),
  messages: text("messages").notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

// ─── issue ─────────────────────────────────────────────────────────
// NOTE: project_id and thread_id are bare TEXT — no FK constraint.
export const issue = sqliteTable(
  "issue",
  {
    issueId: text("issue_id").primaryKey(),
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    threadId: text("thread_id").notNull(),
    description: text("description").notNull().default(""),
    priority: text("priority").notNull().default("P2"),
    estimatedCompletionAt: integer("estimated_completion_at", { mode: "number" }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
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
    projectId: text("project_id").primaryKey(),
    name: text("name").notNull(),
    repoUrl: text("repo_url"),
    defaultBranch: text("default_branch"),
    autoOrchestrate: integer("auto_orchestrate").notNull().default(0),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("idx_project_name").on(table.name)],
);

// ─── column_config ─────────────────────────────────────────────────
export const columnConfig = sqliteTable(
  "column_config",
  {
    configId: text("config_id").primaryKey(),
    projectId: text("project_id").notNull(),
    status: text("status").notNull(),
    agentId: text("agent_id").notNull(),
    promptTemplate: text("prompt_template").notNull(),
    approvalPosture: text("approval_posture").notNull().default("auto"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
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
    deliverableId: text("deliverable_id").primaryKey(),
    issueId: text("issue_id").notNull(),
    fromStatus: text("from_status").notNull(),
    kind: text("kind").notNull(),
    fields: text("fields").notNull(),
    ref: text("ref"),
    runId: text("run_id"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_deliverable_issue").on(table.issueId),
    index("idx_deliverable_issue_kind").on(table.issueId, table.kind),
    uniqueIndex("idx_deliverable_run_kind")
      .on(table.runId, table.kind)
      .where(sql`run_id IS NOT NULL`),
  ],
);
