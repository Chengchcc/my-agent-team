import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
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
    workspacePath: text().notNull().unique(),
    /** Materialized cache of the parsed workspace `agent.yml` (ADR 0020
     *  decision 1: the file is the single source; content columns are
     *  folded into this JSON). */
    config: text().notNull().default("{}"),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
    archivedAt: integer({ mode: "number" }),
  },
  (table) => [index("idx_agents_archived").on(table.archivedAt)],
);

// ─── conversation ──────────────────────────────────────────────────
export const conversation = sqliteTable(
  "conversation",
  {
    conversationId: text().primaryKey(),
    /** 1:1 collapse (spec 2026-08-25): the conversation's agent. Nullable on
     *  legacy rows that predate the member table removal. */
    agentId: text("agent_id"),
    hopCount: integer().notNull().default(0),
    title: text(),
    origin: text().notNull().default("user"),
    createdAt: integer({ mode: "number" }).notNull(),
    forkSource: text("fork_source"),
    forkFromSeq: integer("fork_from_seq"),
    /** ADR 0077: which requirement this room is currently advancing. The
     *  pointer is what makes requirement/conversation M:N usable — a message
     *  advances exactly one requirement, and switching is an explicit act. */
    currentRequirementId: text("current_requirement_id").references(
      () => requirement.requirementId,
    ),
    /** Project binding (ADR 0023): the room's project for dispatch guards and
     *  briefs. ADR 0077: it no longer selects a workspace — the requirement does. */
    projectId: text("project_id").references(() => project.projectId, {
      onDelete: "restrict",
    }),
    /** ADR 0070: the room that dispatched into this one. A dispatch opens a
     *  CHILD CONVERSATION for the worker instead of planting a run in the
     *  front desk's room, so the worker's process has its own ledger and the
     *  front desk's room keeps one summary line plus a link.
     *  Null = a root room (the human's). */
    parentConversationId: text("parent_conversation_id").references(
      (): AnySQLiteColumn => conversation.conversationId,
      { onDelete: "cascade" },
    ),
  },
  (table) => [
    index("idx_conversation_parent").on(table.parentConversationId),
    index("idx_conversation_project").on(table.projectId),
    index("idx_conversation_current_req").on(table.currentRequirementId),
    index("idx_conversation_agent").on(table.agentId, table.createdAt),
  ],
);

/** ADR 0074: a REQUIREMENT (事项) — the stable work goal the PA identifies
 *  from conversation and maintains continuously. Not a copy of the dispatch
 *  brief: it can exist with no dispatch, survive rework and cross-member
 *  collaboration, and its status derives from execution/request/acceptance
 *  records rather than a summary edit. */
export const requirement = sqliteTable(
  "requirement",
  {
    requirementId: text("requirement_id").primaryKey(),
    /** ADR 0080: what the human accepted, as run references with their
     *  verification verdicts (JSON string[]), and when. Null while open. */
    acceptedEvidence: text("accepted_evidence"),
    acceptedAt: integer("accepted_at", { mode: "number" }),
    /** Short handle (the PA's summary; the user's own words stay on the origin
     *  message — the two are deliberately not merged). */
    title: text().notNull(),
    /** What "done" is after, in one or two sentences. */
    goal: text().notNull(),
    background: text(),
    constraints: text(),
    expectedDeliverables: text("expected_deliverables"),
    acceptanceCriteria: text("acceptance_criteria"),
    /** Stored lifecycle: open | done | cancelled. Everything between
     *  (in_progress / waiting_user / pending_acceptance) is DERIVED in the read
     *  model from runs and pending requests — a summary edit can never mark
     *  work finished. */
    status: text().notNull().default("open"),
    /** ADR 0074: which project the goal belongs to. The PA classifies it from
     *  the request (or asks when two projects fit) — "which project is this
     *  about" is the question that makes requirements navigable later. Null is
     *  honest: some goals have no repository. */
    projectId: text("project_id"),
    /** Where the goal was first stated (the human's words live there). */
    originConversationId: text("origin_conversation_id"),
    originSeq: integer("origin_seq"),
    createdByAgentId: text("created_by_agent_id"),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_requirement_status_updated").on(table.status, table.updatedAt),
    index("idx_requirement_origin_conv").on(table.originConversationId, table.status),
  ],
);

// ─── workspace (ADR 0077): the material of a requirement ──────────
/** A checkout a requirement works in: one project, one branch, never the
 *  default branch. Ownership is the REQUIREMENT's (M:N), not the agent's —
 *  that is what lets two requirements run at once without sharing a tree. */
export const workspace = sqliteTable(
  "workspace",
  {
    workspaceId: text("workspace_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.projectId),
    /** Absolute path on disk (a git worktree of the project mirror). */
    path: text().notNull(),
    /** The branch this checkout commits on (`req/<requirementId>/<project>`). */
    branch: text().notNull(),
    /** Commit the checkout started from (what a review diffs against). */
    baseRef: text("base_ref").notNull(),
    /** open | released. Released keeps the row: history outlives the directory. */
    status: text().notNull().default("open"),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_workspace_project_status").on(table.projectId, table.status, table.updatedAt),
  ],
);

export const requirementWorkspace = sqliteTable(
  "requirement_workspace",
  {
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirement.requirementId),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.workspaceId),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.requirementId, table.workspaceId] }),
    index("idx_req_workspace_workspace").on(table.workspaceId),
  ],
);

export const conversationRequirement = sqliteTable(
  "conversation_requirement",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.conversationId),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirement.requirementId),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.requirementId] }),
    index("idx_conv_req_requirement").on(table.requirementId),
  ],
);

// (member table removed — 1:1 collapse: participation is conversation.agent_id)

// ─── conversation_ledger ───────────────────────────────────────────
export const conversationLedger = sqliteTable(
  "conversation_ledger",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    conversationId: text()
      .notNull()
      .references(() => conversation.conversationId, { onDelete: "cascade" }),
    kind: text().notNull(),
    content: text().notNull(),
    ts: integer({ mode: "number" }).notNull(),
    /** Terminal-commit identity: set on the messages of a completed Agent
     *  Run. Unique per (agent_run_id, message_index) - a run's commit can
     *  never be written twice, even across connections/restarts. */
    agentRunId: text("agent_run_id"),
    /** Ordinal of a committed message within its Run (0-based, canonical
     *  sequence order, ADR 0017). */
    messageIndex: integer({ mode: "number" }).notNull().default(0),
    undone: integer({ mode: "number" }).notNull().default(0),
    /** Bookmark (raft Saved): the user chose to keep this message findable.
     *  Projection-independent - saving never edits the canonical row. */
    saved: integer("saved", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("idx_ledger_conv").on(table.conversationId, table.seq),
    index("idx_ledger_saved").on(table.saved, table.seq),
    uniqueIndex("idx_ledger_agent_run_message")
      .on(table.agentRunId, table.messageIndex)
      .where(sql`agent_run_id IS NOT NULL`),
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
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("idx_project_name").on(table.name)],
);

// ─── workflow_execution (Agentic Workflow) ──────────────────────────
export const workflowExecution = sqliteTable(
  "workflow_execution",
  {
    executionId: text("execution_id").notNull().primaryKey(),
    workflowId: text("workflow_id").notNull(),
    triggeredBy: text("triggered_by"), // manual | cron:<expr>
    definition: text("definition").notNull(), // JSON: WorkflowDefinition snapshot
    input: text("input").notNull(), // JSON: trigger input vars
    store: text("store").notNull().default("{}"),
    status: text().notNull().default("running"), // running | waiting_human | success | failure | custom
    exit: text(),
    error: text(),
    /** ADR 0082 D2: optional causal linkage back to the requirement, conversation, or project. */
    requirementId: text("requirement_id").references(() => requirement.requirementId, {
      onDelete: "set null",
    }),
    conversationId: text("conversation_id").references(() => conversation.conversationId, {
      onDelete: "set null",
    }),
    projectId: text("project_id").references(() => project.projectId, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    terminalAt: integer("terminal_at", { mode: "number" }),
  },
  (table) => [
    index("idx_workflow_execution_requirement").on(table.requirementId, table.createdAt),
    index("idx_workflow_execution_conversation").on(table.conversationId, table.createdAt),
    index("idx_workflow_execution_project").on(table.projectId, table.createdAt),
    index("idx_workflow_execution_wf_status").on(table.workflowId, table.status),
    uniqueIndex("idx_workflow_execution_single_flight")
      .on(table.workflowId)
      .where(sql`status = 'running'`),
  ],
);

export const workflowNodeRun = sqliteTable(
  "workflow_node_run",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    executionId: text("execution_id")
      .notNull()
      .references(() => workflowExecution.executionId, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    runId: text("run_id"), // agent run id for reconnect
    status: text().notNull().default("running"), // running | waiting_human | completed | failed | superseded
    order: integer().notNull(),
    output: text(), // JSON
    routedTo: text(), // JSON string[]
    error: text(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    terminalAt: integer("terminal_at", { mode: "number" }),
  },
  (table) => [
    index("idx_workflow_node_run_exec").on(table.executionId, table.seq),
    index("idx_workflow_node_run_exec_status").on(table.executionId, table.status),
    index("idx_workflow_node_run_run_id").on(table.runId),
  ],
);

export const workflowExecutionEvent = sqliteTable(
  "workflow_execution_event",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    executionId: text("execution_id")
      .notNull()
      .references(() => workflowExecution.executionId, { onDelete: "cascade" }),
    event: text().notNull(), // node_started | node_completed | node_failed | store_write | human_task_requested | rework_requested | budget_exhausted | execution_terminal
    data: text().notNull(), // JSON payload
    ts: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_workflow_execution_event_exec").on(table.executionId, table.seq),
    index("idx_workflow_execution_event_ts").on(table.ts),
  ],
);

export const workflowPendingHuman = sqliteTable(
  "workflow_pending_human",
  {
    executionId: text("execution_id")
      .notNull()
      .references(() => workflowExecution.executionId, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    question: text(),
    form: text(), // JSON Record<string, FormField>
    status: text().notNull().default("pending"), // pending | resolved
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    terminalAt: integer("terminal_at", { mode: "number" }),
  },
  (table) => [primaryKey({ columns: [table.executionId, table.nodeId] })],
);

// ── Execution-related tables (merged into single-db under S1 storage convergence) ──
// Phase 6: span/attempt/control_plane_event/span_origin dropped — Agent Run is
// the only Product execution identity (agent_run + product_tool_call hold the facts).

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
    keepSynced: integer({ mode: "boolean" }).notNull().default(false),
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

// ─── settings (KV store for runtime-tunable config) ────────────────
export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(), // JSON string
  updatedAt: integer({ mode: "number" }).notNull(),
});

// ─── Zod schemas (type chain: drizzle table → Zod → z.infer → TS type) ──

import { createSelectSchema } from "drizzle-zod";

// ── Simple tables (drizzle-zod auto-generate) ──

export const agentsSelectSchema = createSelectSchema(agents);
export const conversationSelectSchema = createSelectSchema(conversation);
export const skillPackSelectSchema = createSelectSchema(skillPack, {
  sourceKind: (s) => s.transform((v) => v as "builtin" | "git" | "zip"),
  status: (s) => s.transform((v) => v as "pending" | "installing" | "ready" | "failed" | "syncing"),
});
export const agentSkillPackSelectSchema = createSelectSchema(agentSkillPack);

// ── Tables with JSON/bool columns — drizzle-zod refine callback pattern ──
// callback (schema) => schema.transform(...) adds transforms while preserving drizzle-zod types

export const surfaceHealthSelectSchema = createSelectSchema(surfaceHealth, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const conversationLedgerSelectSchema = createSelectSchema(conversationLedger, {
  content: (s) => s.transform((v: string) => JSON.parse(v) as unknown),
  undone: (s) => s.transform((v: number) => v !== 0),
});

export const projectSelectSchema = createSelectSchema(project);

/** Convert boolean to 0|1 for integer columns. Single source of truth


 *  for the bool→int conversion used by adapters. */
export const boolToInt = (v: boolean): number => (v ? 1 : 0);

// ─── Phase 1: Agent Context, Branches, Runs, Queue, PendingAction ──────────
// DESTRUCTIVE CLEAN CUTOVER - old session/checkpoint state is intentionally discarded.

// Agent Context Tree: one per (conversation, agent).
export const agentContextTree = sqliteTable(
  "agent_context_tree",
  {
    treeId: text("tree_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.conversationId, { onDelete: "cascade" }),
    /** ADR 0041: one tree per (conversation, agent) — a member agent's
     *  isolated context line inside the room. Nullable on legacy rows;
     *  backfilled by migration 0053. */
    agentId: text("agent_id"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.treeId] }),
    uniqueIndex("idx_context_tree_conversation_agent").on(table.conversationId, table.agentId),
  ],
);

// Agent Context Entry: append-only tree nodes with parent links.
export const agentContextEntry = sqliteTable(
  "agent_context_entry",
  {
    entryId: text("entry_id").notNull(),
    treeId: text("tree_id")
      .notNull()
      .references(() => agentContextTree.treeId, { onDelete: "cascade" }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- self-referencing FK requires any
    parentId: text("parent_id").references((): any => agentContextEntry.entryId),
    type: text().notNull(), // ledger_message | summary
    payload: text().notNull(), // JSON: type-specific payload
    ledgerSeq: integer("ledger_seq"), // only for ledger_message
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entryId] }),
    index("idx_context_entry_tree").on(table.treeId, table.parentId),
    index("idx_context_entry_leaf").on(table.treeId, table.entryId),
    index("idx_context_entry_tree_seq").on(table.treeId, table.type, table.ledgerSeq),
  ],
);

// Context Branch: a path from root to a leaf entry.
export const agentContextBranch = sqliteTable(
  "agent_context_branch",
  {
    branchId: text("branch_id").notNull(),
    treeId: text("tree_id")
      .notNull()
      .references(() => agentContextTree.treeId, { onDelete: "cascade" }),
    leafEntryId: text("leaf_entry_id"),
    ledgerCursor: integer("ledger_cursor").notNull().default(0),
    backendKind: text("backend_kind").notNull(),
    /** CLI session reference (ADR 0002): claude session_id or pi/omp
     *  session file path — the CLI-side runtime truth for context
     *  continuation. Null until the first CLI-backed run on the branch. */
    cliSessionRef: text("cli_session_ref"),
    isDefault: integer("is_default", { mode: "number" }).notNull().default(0),
    revision: integer().notNull().default(1),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.branchId] }),
    // One default branch per tree (partial unique index).
    uniqueIndex("idx_context_branch_default").on(table.treeId).where(sql`is_default = 1`),
    index("idx_context_branch_tree").on(table.treeId),
  ],
);

// Agent Run: product execution identity.
export const agentRun = sqliteTable(
  "agent_run",
  {
    runId: text("run_id").notNull(),
    branchId: text("branch_id")
      .notNull()
      .references(() => agentContextBranch.branchId, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    agentId: text("agent_id").notNull(),
    modelRef: text("model_ref").notNull(), // JSON: BackendModelRef
    status: text().notNull().default("running"), // running|waiting|commit_failed|completed|failed|aborted|timeout
    idempotencyKey: text("idempotency_key").notNull(),
    terminalResult: text("terminal_result"), // JSON: serialized BackendRunOutcome, set on terminal
    configRevision: integer("config_revision").notNull(),
    /** Run-level workspace snapshot: root + access. Null = resolve from the
     *  agent member record at dispatch. */
    workspaceRoot: text("workspace_root"),
    workspaceAccess: text("workspace_access"),
    /** JSON: the run's Product Tool manifest (ProductToolDescriptor[]),
     *  written at first dispatch; Product Tools MCP validates against it. */
    productTools: text("product_tools"),
    /** Frozen system prompt (Agent identity for Conversation/Cron runs;
     *  LOOP.md generator/evaluator prompt for Loop runs). Null = none. */
    systemPrompt: text("system_prompt"),
    /** JSON: frozen skill pack roots (absolute dirs scanned for SKILL.md). */
    skillRoots: text("skill_roots"),
    /** Frozen permission_mode (ask/auto/deny/yolo), mapped per backend at
     *  dispatch (ADR 0020 decision 7; claude --permission-mode). */
    permissionMode: text("permission_mode"),
    /** JSON {deny,allow}: frozen write-path policy injected into the child as
     *  OMA_DENY_WRITE_PATHS / OMA_ALLOW_WRITE_PATHS (allow-rules, first slice).
     *  Stored on the run so it is frozen with the rest of the config. */
    toolPolicy: text("write_path_policy"),
    /** JSON: the run's latest task list snapshot (todo_write product tool).
     *  Re-injected into the next run's prompt as the Current Tasks section. */
    todoSnapshot: text("todo_snapshot"),
    /** ADR 0047: why this run may run — `user`, `dispatch:<fromAgentId>`,
     *  `system`. Frozen at acquire time. */
    authorization: text("authorization"),
    /** ADR 0080: risk the DISPATCHER declared for this run's work (JSON:
     *  `{irreversible?: boolean}`). An approval raised by a run carrying
     *  `irreversible` is the person's, never an agent's (audit 2026-11-24). */
    risk: text("risk"),
    /** ADR 0051: the run that dispatched THIS one (`dispatch:<agent>` chains
     *  lose their origin otherwise — audit needs the whole chain, not one
     *  hop). Null = no parent (human input, rule, assessment, system). */
    parentRunId: text("parent_run_id"),
    /** ADR 0074: the requirement this run executes for. Set by the dispatch
     *  tool; runs without one (chat, wiki upkeep) carry null. */
    requirementId: text("requirement_id").references(() => requirement.requirementId, {
      onDelete: "set null",
    }),
    /** The native (ACP) session THIS run actually executed in, written the
     *  moment session/new or session/load succeeds — not at terminal commit.
     *  A run that dies parked (HITL) or mid-crash still knows its own
     *  continuation identity, so recovery never scans for "the newest
     *  interrupted session" (#25). Null = no session bound yet. */
    nativeSessionRef: text("native_session_ref"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    terminalAt: integer("terminal_at", { mode: "number" }),
    /** ADR 0060 D6: when the terminal notice reached the dispatcher. Null on
     *  a terminal dispatched run means the notice may have been lost between
     *  the commit and the delivery - recovery re-delivers it (at-least-once;
     *  the steer rail is idempotent by input key). */
    resultNotifiedAt: integer("result_notified_at", { mode: "number" }),
    /** ADR 0061 D1: a terminal notice the human has not looked at yet. Set
     *  when the conversation (or the row itself) is opened. */
    resultSeenAt: integer("result_seen_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.runId] }),
    uniqueIndex("idx_agent_run_idempotency").on(table.idempotencyKey),
    // Single active run per branch: partial unique index on active statuses.
    uniqueIndex("idx_agent_run_active_branch")
      .on(table.branchId)
      .where(sql`status IN ('running', 'waiting', 'commit_failed')`),
    index("idx_agent_run_branch").on(table.branchId),
    index("idx_agent_run_status_created").on(table.status, table.createdAt),
    index("idx_agent_run_conv_created").on(table.conversationId, table.createdAt),
    index("idx_agent_run_agent_created").on(table.agentId, table.createdAt),
    index("idx_agent_run_parent").on(table.parentRunId),
    index("idx_agent_run_requirement").on(table.requirementId, table.createdAt),
    index("idx_agent_run_unnotified")
      .on(table.status, table.resultNotifiedAt)
      .where(sql`parent_run_id IS NOT NULL AND result_notified_at IS NULL`),
  ],
);

// Run telemetry: durable normalized backend events (tool calls, status,
// workflow steps). Transient text deltas are NOT persisted; usage lives on
// agent_run.terminal_result. Written by the execution broadcast fan-out.
export const agentRunEvent = sqliteTable(
  "agent_run_event",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRun.runId, { onDelete: "cascade" }),
    type: text().notNull(),
    /** JSON: the normalized BackendEvent payload. */
    data: text().notNull(),
    ts: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_agent_run_event_run").on(table.runId, table.seq),
    index("idx_agent_run_event_ts").on(table.ts),
  ],
);

// Branch Input Queue: durable normal/steer/follow_up inputs.
export const branchInputQueue = sqliteTable(
  "branch_input_queue",
  {
    /** Monotonic insertion order (the real queue sequence): the sort key for
     *  claim/recover/list. Never derived from timestamps or random ids. */
    seq: integer().primaryKey({ autoIncrement: true }),
    inputId: text("input_id").notNull().unique(),
    branchId: text("branch_id")
      .notNull()
      .references(() => agentContextBranch.branchId, { onDelete: "cascade" }),
    mode: text().notNull(), // normal | steer | follow_up
    message: text().notNull(), // JSON: serialized Message
    status: text().notNull().default("pending"), // pending | delivering | delivered | cancelled
    deliveryIdempotencyKey: text("delivery_idempotency_key").notNull(),
    inputIdempotencyKey: text("input_idempotency_key").notNull(),
    runId: text("run_id"), // set when acquired
    /** Request-time Run config snapshot (JSON BackendModelRef). Persisted on
     *  the queue row so a later promote (acquireNextRun) uses THIS input's
     *  snapshot, never the previous Run's config. */
    modelRef: text("model_ref"),
    configRevision: integer("config_revision"),
    workspaceRoot: text("workspace_root"),
    workspaceAccess: text("workspace_access"),
    systemPrompt: text("system_prompt"),
    skillRoots: text("skill_roots"), // JSON: readonly string[]
    permissionMode: text("permission_mode"),
    /** JSON {deny,allow,denyCommands,disabledTools}: frozen tool policy
     *  so queued inputs promoted by acquireNextRun keep the same boundaries. */
    toolPolicy: text("write_path_policy"),
    /** ADR 0047 authorization basis, frozen with the rest of the request
     *  snapshot: a QUEUED dispatch/ambient input must promote with its
     *  authority intact, not lose it at the run boundary. */
    authorization: text("authorization"),
    /** ADR 0051: rides the snapshot like authorization — a queued dispatch
     *  must promote with its parent link intact. */
    parentRunId: text("parent_run_id"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    deliveredAt: integer("delivered_at", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("idx_queue_delivery_idem").on(table.deliveryIdempotencyKey),
    uniqueIndex("idx_queue_input_idem").on(table.branchId, table.inputIdempotencyKey),
    // Stable queue ordering: branch + monotonic seq.
    index("idx_queue_order").on(table.branchId, table.seq),
    index("idx_queue_status_branch_seq").on(table.status, table.branchId, table.seq),
    index("idx_queue_run_id").on(table.runId),
  ],
);

// Pending Action: approval/question awaiting a response.
export const pendingAction = sqliteTable(
  "pending_action",
  {
    actionId: text("action_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRun.runId, { onDelete: "cascade" }),
    kind: text().notNull(),
    payload: text().notNull(), // JSON
    status: text().notNull().default("pending"), // pending | resolved | cancelled
    response: text(), // JSON: PendingActionResponse
    responseIdempotencyKey: text("response_idempotency_key"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "number" }),
    /** ADR 0061 D2: when a human first opened this question. `unread` is
     *  advanced only by the OTHER side's action, never by our own look. */
    seenAt: integer("seen_at", { mode: "number" }),
    /** ADR 0075: who is expected to answer right now.
     *  `agent:<id>` (the dispatcher looks first) or `user` (escalated). */
    owner: text(),
    /** ADR 0075: who actually answered — `agent:<id>` or `user`. Null while
     *  pending; it is the audit fact that separates an answered request from
     *  a decided one. */
    answeredBy: text("answered_by"),
    /** ADR 0075: the same request after escalation keeps ONE row; this points
     *  at nothing extra, it records that the owner changed at (ms). */
    escalatedAt: integer("escalated_at", { mode: "number" }),
    /** ADR 0075: what the answering agent cited (wiki path / brief ref /
     *  project id). Required for an agent answer: no evidence, no answer. */
    evidence: text(), // JSON string[]
  },
  (table) => [
    primaryKey({ columns: [table.actionId] }),
    uniqueIndex("idx_pending_action_response_idem").on(table.responseIdempotencyKey),
    index("idx_pending_action_run").on(table.runId),
    index("idx_pending_action_status_run").on(table.status, table.runId),
  ],
);

// ADR 0061 D3: a human's unsent free-text answer. One row per question; the
// body survives reloads, and a successful answer deletes it. It is not a
// fact: drafts never enter the ledger.
export const answerDraft = sqliteTable(
  "answer_draft",
  {
    runId: text("run_id").notNull(),
    callId: text("call_id").notNull(),
    body: text("body").notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.callId] })],
);

// Lark setup session: the wizard's authorization attempt. Persisted (not a
// Map) so a restart does not lose the session, and EXPIRED/CANCELLED rows are
// kept as tombstones - the read model reports "the link expired" from them,
// which an in-memory map that deleted on expiry could never say.
export const larkSetupSession = sqliteTable(
  "lark_setup_session",
  {
    setupId: text("setup_id").notNull(),
    agentId: text("agent_id").notNull(),
    profileRef: text("profile_ref").notNull(),
    botDisplayName: text("bot_display_name"),
    brand: text().notNull().default("feishu"), // feishu | lark
    status: text().notNull().default("pending"), // pending | completed | failed | expired | cancelled
    url: text(),
    error: text(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.setupId] }),
    index("idx_lark_setup_agent").on(table.agentId, table.createdAt),
  ],
);

// Product Tool Call: durable idempotency + audit for SEMANTIC MUTATION calls
// (e.g. history_retain). Read-only tools never write here. One row per
// (runId, callId); replay returns the stored result, conflicting input fails.
export const productToolCall = sqliteTable(
  "product_tool_call",
  {
    runId: text("run_id")
      .notNull()
      .references(() => agentRun.runId, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    toolName: text("tool_name").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text().notNull().default("completed"), // completed | failed
    result: text(), // JSON: standardized tool result
    error: text(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    completedAt: integer("completed_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.callId] }),
    index("idx_product_tool_call_run").on(table.runId),
    index("idx_product_tool_call_created").on(table.createdAt),
  ],
);

// ── Phase 1 select schemas (JSON/bool columns need transform pattern) ──

export const agentContextEntrySelectSchema = createSelectSchema(agentContextEntry, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const agentContextBranchSelectSchema = createSelectSchema(agentContextBranch, {
  isDefault: (s) => s.transform((v: number) => v !== 0),
});

export const agentRunSelectSchema = createSelectSchema(agentRun, {
  modelRef: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
  terminalResult: (s) =>
    s.transform((v: string | null) => (v ? (JSON.parse(v) as Record<string, unknown>) : null)),
});

export const branchInputQueueSelectSchema = createSelectSchema(branchInputQueue, {
  message: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const pendingActionSelectSchema = createSelectSchema(pendingAction, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
  response: (s) =>
    s.transform((v: string | null) => (v ? (JSON.parse(v) as Record<string, unknown>) : null)),
});

// ─── proposal (ADR 0040: what an agent proposed and did not do) ───────────
/** An MCP tool can rewrite an agent's config or a workflow's definition, but it must not apply
 *  the change: it proposes it, and the target page adopts it as an unsaved edit the human commits.
 *  Durable because the tool's own answer tells the user where to review it. */
export const proposal = sqliteTable(
  "proposal",
  {
    id: text().primaryKey(),
    kind: text().notNull(),
    targetId: text().notNull(),
    payload: text().notNull(),
    status: text().notNull(),
    createdAt: integer({ mode: "number" }).notNull(),
    resolvedAt: integer({ mode: "number" }),
  },
  (table) => [
    index("idx_proposal_pending").on(table.kind, table.targetId, table.status),
    index("idx_proposal_status_created").on(table.status, table.createdAt),
  ],
);

export const proposalSelectSchema = createSelectSchema(proposal, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as unknown),
});

/** A one-shot timed nudge (raft step 2): when fire_at arrives, the reminder
 *  tick posts the text into the bound conversation as a normal input and a
 *  regular run voices it. fired_at null = pending; set on delivery — errors
 *  are logged and the row is still marked fired (a reminder for a deleted
 *  conversation must not retry forever). */
export const reminder = sqliteTable(
  "reminder",
  {
    id: text().primaryKey(),
    conversationId: text()
      .notNull()
      .references(() => conversation.conversationId, {
        onDelete: "cascade",
      }),
    /** Agent id or the constant "user" — who asked for it (raft: only the
     *  author is reminded; we deliver to the conversation instead). */
    createdBy: text().notNull(),
    /** 5-field cron expression: fire, then reschedule to the next match
     *  (raft recurring wake-ups). Null = one-shot. */
    recurrence: text("recurrence"),
    text: text().notNull(),
    fireAt: integer({ mode: "number" }).notNull(),
    firedAt: integer({ mode: "number" }),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_reminder_due").on(table.firedAt, table.fireAt),
    index("idx_reminder_conversation").on(table.conversationId, table.createdAt),
  ],
);

/** ADR 0082 D1: Artifact metadata & cross-entity provenance index. File bytes
 *  remain on disk; SQLite is the query/filter source of truth. */
export const artifact = sqliteTable(
  "artifact",
  {
    url: text("url").primaryKey(),
    folder: text("folder").notNull(),
    filename: text("filename").notNull(),
    size: integer("size", { mode: "number" }).notNull(),
    mimeType: text("mime_type").notNull(),
    encoding: text("encoding").notNull(), // utf8 | base64
    sha256: text("sha256"),
    runId: text("run_id").references(() => agentRun.runId, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversation.conversationId, {
      onDelete: "set null",
    }),
    requirementId: text("requirement_id").references(() => requirement.requirementId, {
      onDelete: "set null",
    }),
    workflowExecutionId: text("workflow_execution_id").references(
      () => workflowExecution.executionId,
      { onDelete: "set null" },
    ),
    agentId: text("agent_id"),
    projectId: text("project_id").references(() => project.projectId, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_artifact_folder").on(table.folder, table.updatedAt),
    index("idx_artifact_requirement").on(table.requirementId, table.updatedAt),
    index("idx_artifact_conversation").on(table.conversationId, table.updatedAt),
    index("idx_artifact_execution").on(table.workflowExecutionId, table.updatedAt),
    index("idx_artifact_run").on(table.runId),
  ],
);

/** ADR 0082 D3: Persisted Coding terminal layout & linkage (replaces
 *  `terminals.json`). Live PTYs remain process-owned (ADR 0073). */
export const codingTerminal = sqliteTable(
  "coding_terminal",
  {
    terminalId: text("terminal_id").primaryKey(),
    projectId: text("project_id").references(() => project.projectId, { onDelete: "set null" }),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").references(() => workspace.workspaceId, {
      onDelete: "set null",
    }),
    conversationId: text("conversation_id").references(() => conversation.conversationId, {
      onDelete: "set null",
    }),
    requirementId: text("requirement_id").references(() => requirement.requirementId, {
      onDelete: "set null",
    }),
    cwd: text("cwd").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("shell"), // shell | oma
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_coding_terminal_conversation").on(table.conversationId),
    index("idx_coding_terminal_requirement").on(table.requirementId),
    index("idx_coding_terminal_project").on(table.projectId),
    index("idx_coding_terminal_agent").on(table.agentId),
  ],
);
