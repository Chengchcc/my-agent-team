# M19 Implementation Plan — 编排单一权威 · Issue 富化 · Coding Thread · 看板工作台

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify three run-start paths into a single dispatcher with explicit `origin_kind`, enrich Issue with description/priority/ETA, switch prompt rendering to sandboxed Handlebars, add read-only issue tools, connect issue runs to conversation projection for Coding Thread, and add frontend kanban features (priority badges, auto-orchestrate toggle, Sheet detail, edit/delete).

**Architecture:** Backend changes flow through features/ directory with adapters/services/HTTP layers. A new `run/dispatcher.ts` is the single run-start mechanism. `origin_kind` drives mutual exclusion between reactor and projection. Frontend uses existing shadcn components with functional increments only.

**Tech Stack:** TypeScript, bun:sqlite, Handlebars, Zod, Next.js with shadcn/ui, @dnd-kit

---

## Part A — RunDispatcher + origin_kind

### Task A1: Add origin_kind migration (events DB)

**Files:**
- Modify: `apps/backend/src/features/run/events-db-migrations.ts`

- [ ] **Step 1: Add migration entry**

Append after `events_v15_issue_event` (id=3014):

```ts
{
  name: "events_v16_run_origin_kind",
  id: 3015,
  up: `ALTER TABLE run_origin ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'manual';`,
},
```

- [ ] **Step 2: Run backend tests to verify migration applies**

```bash
cd apps/backend && bun test --test-name-pattern="events-db"
```

Expected: PASS (existing migration tests still pass; new migration auto-applies)

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/run/events-db-migrations.ts
git commit -m "feat: add origin_kind column to run_origin (events_v16)"
```

---

### Task A2: Add RunOriginKind type + update store

**Files:**
- Modify: `apps/backend/src/features/runtime-ops/types.ts`
- Modify: `apps/backend/src/features/runtime-ops/store.ts`

- [ ] **Step 1: Add type to types.ts**

After `RunOpsEventKind` type, add:

```ts
export type RunOriginKind = "orchestrator" | "mention" | "manual";
```

Then modify `RunOriginRow` to include:

```ts
originKind: RunOriginKind;
```

- [ ] **Step 2: Update RUN_ORIGIN_COLS in store.ts**

Change the `RUN_ORIGIN_COLS` constant to add `origin_kind AS originKind`:

```ts
const RUN_ORIGIN_COLS = `run_id AS runId, conversation_id AS conversationId, source_ledger_seq AS sourceLedgerSeq, agent_member_id AS agentMemberId, surface, trace_id AS traceId, traceparent, idempotency_key AS idempotencyKey, issue_id AS issueId, from_status AS fromStatus, origin_kind AS originKind, created_at AS createdAt`;
```

- [ ] **Step 3: Update insertRunOrigin to write originKind**

Modify the `INSERT OR IGNORE` statement in `insertRunOrigin` to include `origin_kind`:

```ts
this.#db.run(
  `INSERT OR IGNORE INTO run_origin (run_id, conversation_id, source_ledger_seq, agent_member_id, surface, trace_id, traceparent, idempotency_key, issue_id, from_status, origin_kind, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    row.runId,
    row.conversationId,
    row.sourceLedgerSeq,
    row.agentMemberId,
    row.surface,
    row.traceId,
    row.traceparent,
    row.idempotencyKey,
    row.issueId ?? null,
    row.fromStatus,
    row.originKind,   // NEW
    row.createdAt,
  ],
);
```

- [ ] **Step 4: Run tests**

```bash
cd apps/backend && bun test --test-name-pattern="store"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/runtime-ops/types.ts apps/backend/src/features/runtime-ops/store.ts
git commit -m "feat: add RunOriginKind type and store support for origin_kind"
```

---

### Task A3: Create RunDispatcher

**Files:**
- Create: `apps/backend/src/features/run/dispatcher.ts`

- [ ] **Step 1: Create dispatcher.ts**

```ts
import type { RunSupervisor } from "../run/supervisor.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import type { RunOriginKind, RunOriginRow } from "../runtime-ops/types.js";

export type RunOriginInput = Omit<RunOriginRow, "originKind" | "createdAt">;

export type DispatchCause = {
  kind: RunOriginKind;
  runId: string;
  threadId: string;
  spec: Record<string, unknown>;
  opts?: Record<string, unknown>;
  origin: RunOriginInput;
};

export function createRunDispatcher(deps: {
  supervisor: RunSupervisor;
  opsStore: RuntimeOpsStore;
  now?: () => number;
}) {
  return {
    async dispatch(cause: DispatchCause): Promise<{ runId: string; attemptId: string }> {
      const { attemptId } = await deps.supervisor.startMainRun(
        cause.runId,
        cause.threadId,
        cause.spec,
        cause.opts as Parameters<RunSupervisor["startMainRun"]>[3] | undefined,
      );
      deps.opsStore.insertRunOrigin({
        ...cause.origin,
        runId: cause.runId,
        originKind: cause.kind,
        createdAt: (deps.now ?? Date.now)(),
      });
      return { runId: cause.runId, attemptId };
    },
  };
}

export type RunDispatcher = ReturnType<typeof createRunDispatcher>;
```

- [ ] **Step 2: Verify compile**

```bash
cd apps/backend && bun run typecheck
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/run/dispatcher.ts
git commit -m "feat: add RunDispatcher — single run-start + origin_kind mechanism"
```

---

### Task A4: Wire orchestrator reactor to use dispatcher

**Files:**
- Modify: `apps/backend/src/features/orchestrator/reactor.ts`

- [ ] **Step 1: Update OrchestratorDeps to include dispatcher**

Add dispatcher field:

```ts
import type { RunDispatcher } from "../run/dispatcher.js";

export interface OrchestratorDeps {
  // ...existing fields...
  dispatcher: RunDispatcher;
}
```

- [ ] **Step 2: Rewrite startStep to use dispatcher**

Replace the `startStep` function body (lines 59-106). The key change: replace `supervisor.startMainRun` + `opsStore.insertRunOrigin` with `dispatcher.dispatch`:

```ts
async function startStep(issue: IssueRow): Promise<{ runId: string } | null> {
  const table = columnConfigSvc.transitionsForProject(issue.projectId);
  const t = nextTransition(table, issue.status);
  if (!t) return null;

  const agent = await agentSvc.getById(t.agentId).catch(() => null);
  if (!agent) {
    throw new OrchestratorAgentMissingError(t.agentId, issue.issueId);
  }

  const runId = idGen();
  const vars = buildPromptVars(issue, deliverableSvc.listByIssue(issue.issueId));
  const prompt = renderPrompt(t.promptTemplate, vars);
  const spec = await buildSpec(t.agentId, issue.threadId, prompt);

  await dispatcher.dispatch({
    kind: "orchestrator",
    runId,
    threadId: issue.threadId,
    spec,
    opts: {
      surfaceContext: {
        surface: "orchestrator",
        conversationId: "",
        runId,
        capabilities: ["submit_deliverable"],
        issue: { issueId: issue.issueId, fromStatus: issue.status },
      },
    },
    origin: {
      issueId: issue.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: t.agentId,
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: runId,
      fromStatus: issue.status,
    },
  });

  emitIssueEvent(opsStore, issue.issueId, "run.started", {
    runId,
    fromStatus: issue.status,
    agentId: t.agentId,
  });

  return { runId };
}
```

- [ ] **Step 3: Run orchestrator tests**

```bash
cd apps/backend && bun test --test-name-pattern="reactor"
```

Expected: PASS (behavior unchanged)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/orchestrator/reactor.ts
git commit -m "feat: wire orchestrator reactor to use RunDispatcher"
```

---

### Task A5: Wire manual start (run/service.ts) to use dispatcher

**Files:**
- Modify: `apps/backend/src/features/run/service.ts`

- [ ] **Step 1: Update RunServiceDeps to include dispatcher**

Add to interface:

```ts
import type { RunDispatcher } from "./dispatcher.js";

export interface RunServiceDeps {
  // ...existing fields...
  dispatcher: RunDispatcher;
}
```

- [ ] **Step 2: Rewrite start() to use dispatcher**

Replace `supervisor.startMainRun` call with `dispatcher.dispatch`, adding `insertRunOrigin` (currently missing for manual starts):

```ts
async start(threadId: string, spec: Record<string, unknown>) {
  const cid = parseThreadId(threadId).conversationId || threadId;
  const memberId = parseThreadId(threadId).memberId || threadId;
  if (!lock.acquireThread(threadId, cid)) throw new ThreadBusyError(threadId);
  if (supervisor.activeCount >= maxConcurrentRuns) {
    lock.releaseThread(threadId, cid);
    throw new TooManyRunsError(maxConcurrentRuns);
  }

  const runId = idGen();

  try {
    const { attemptId } = await dispatcher.dispatch({
      kind: "manual",
      runId,
      threadId,
      spec,
      opts: {}, // manual start currently sends no extra opts beyond spec
      origin: {
        conversationId: cid,
        sourceLedgerSeq: 0,
        agentMemberId: memberId,
        surface: "web",
        traceId: "",
        traceparent: "",
        idempotencyKey: runId,
        issueId: null,
        fromStatus: "",
      },
    });
    return { runId, attemptId };
  } catch (err) {
    lock.releaseThread(threadId, cid);
    throw err;
  }
},
```

- [ ] **Step 3: Run tests**

```bash
cd apps/backend && bun test --test-name-pattern="run.*service"
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/run/service.ts
git commit -m "feat: wire manual run start to use RunDispatcher with origin_kind=manual"
```

---

### Task A6: Wire @mention forkRun to use dispatcher

**Files:**
- Modify: `apps/backend/src/features/conversation/conv-svc-factory.ts`

- [ ] **Step 1: Update forkRun to use dispatcher**

Replace `supervisor.startMainRun` + `opsStore.insertRunOrigin` with `dispatcher.dispatch`:

```ts
import { createRunDispatcher } from "../run/dispatcher.js";

// Inside createConversationFeature, accept dispatcher:
export function createConversationFeature(
  db: Database,
  _config: BackendConfig,
  supervisor: RunSupervisor,
  agentSvc: AgentService,
  opsStore: RuntimeOpsStore,
  tracer: RuntimeTracer,
  dispatcher?: RunDispatcher,  // NEW optional param
): ConversationFeature {
```

In forkRun closure, replace lines 81-98:

```ts
const { attemptId } = await (dispatcher ?? createRunDispatcher({ supervisor, opsStore })).dispatch({
  kind: "mention",
  runId,
  threadId,
  spec,
  opts: {
    preloadedMessages,
    surfaceContext,
    trace,
  },
  origin: {
    conversationId: ctx.conversationId,
    sourceLedgerSeq: ctx.ledgerSeq,
    agentMemberId: ctx.agentMemberId,
    surface: surfaceContext?.surface ?? "web",
    traceId: trace.traceId,
    traceparent: trace.traceparent,
    idempotencyKey: `${ctx.conversationId}:${ctx.ledgerSeq}:run`,
    issueId: null,
    fromStatus: "",
  },
});
```

- [ ] **Step 2: Run conversation tests**

```bash
cd apps/backend && bun test --test-name-pattern="conversation"
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/conversation/conv-svc-factory.ts
git commit -m "feat: wire @mention forkRun to use RunDispatcher with origin_kind=mention"
```

---

### Task A7: Wire main.ts — create dispatcher and inject into all three paths

**Files:**
- Modify: `apps/backend/src/main.ts`

- [ ] **Step 1: Create dispatcher in main.ts**

After `const opsStore = new RuntimeOpsStore(eventsDb);`, add:

```ts
import { createRunDispatcher } from "./features/run/dispatcher.js";

const dispatcher = createRunDispatcher({ supervisor, opsStore });
```

- [ ] **Step 2: Inject dispatcher into runSvc**

Modify `createRunService` call to pass `dispatcher`:

```ts
const runSvc = createRunService({
  supervisor,
  eventLog,
  maxConcurrentRuns: config.maxConcurrentRuns,
  lock: conv.lock,
  idGen: ulid,
  dispatcher,  // NEW
  autoTitle: { ... },
});
```

- [ ] **Step 3: Inject dispatcher into orchestrator**

Modify `createOrchestrator` call to pass `dispatcher`:

```ts
const orchestrator = createOrchestrator({
  issueSvc,
  agentSvc,
  supervisor,
  opsStore,
  buildSpec: buildIssueSpec,
  idGen: ulid,
  columnConfigSvc,
  deliverableSvc,
  dispatcher,  // NEW
});
```

- [ ] **Step 4: Inject dispatcher into conversation feature**

Modify `createConversationFeature` call:

```ts
const conv = createConversationFeature(db, config, supervisor, agentSvc, opsStore, tracer, dispatcher);
```

- [ ] **Step 5: Full backend build check**

```bash
cd apps/backend && bun run typecheck
```

Expected: PASS

- [ ] **Step 6: Run full backend test suite**

```bash
cd apps/backend && bun test
```

Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/main.ts
git commit -m "feat: create RunDispatcher in main.ts, inject into all three run-start paths"
```

---

## Part B — Structured Mutual Exclusion + @mention consolidation

### Task B1: Update reactor onRunComplete to check origin_kind

**Files:**
- Modify: `apps/backend/src/features/orchestrator/reactor.ts`

- [ ] **Step 1: Change guard condition**

Replace lines 117-119:

```ts
// BEFORE:
const origin = opsStore.getRunOrigin(runId);
const issueId = origin?.issueId;
if (!issueId) return;

// AFTER:
const origin = opsStore.getRunOrigin(runId);
if (origin?.originKind !== "orchestrator" || !origin.issueId) return;
const issueId = origin.issueId;
```

- [ ] **Step 2: Run reactor tests**

```bash
cd apps/backend && bun test --test-name-pattern="reactor"
```

Expected: PASS (behavior unchanged for existing orchestrator runs)

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/orchestrator/reactor.ts
git commit -m "feat: reactor onRunComplete guards by origin_kind instead of issueId presence"
```

---

### Task B2: Update projection onRunComplete to check origin_kind

**Files:**
- Modify: `apps/backend/src/features/conversation/projection.ts`

- [ ] **Step 1: Change issue-driven guard**

Replace lines 169-173:

```ts
// BEFORE:
if (opsStore.getRunOrigin(runId)?.issueId) {
  clearAccumulator(runId);
  return;
}

// AFTER:
const origin = opsStore.getRunOrigin(runId);
if (origin?.originKind === "orchestrator") {
  clearAccumulator(runId);
  return;
}
```

- [ ] **Step 2: Run projection tests**

```bash
cd apps/backend && bun test --test-name-pattern="projection"
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/conversation/projection.ts
git commit -m "feat: projection onRunComplete guards by origin_kind instead of issueId presence"
```

---

## Part C — Issue Field Enrichment + PATCH/DELETE

### Task C1: Add Issue migration + types

**Files:**
- Modify: `apps/backend/src/features/issue/entities.ts`
- Modify: `apps/backend/src/infra/sqlite/migrations.ts`

- [ ] **Step 1: Add types to entities.ts**

```ts
export type IssuePriority = "P0" | "P1" | "P2" | "P3";
export const ISSUE_PRIORITIES: readonly IssuePriority[] = ["P0", "P1", "P2", "P3"];

export interface IssueRow {
  issueId: string;
  projectId: string;
  title: string;
  status: IssueStatus;
  threadId: string;
  description: string;
  priority: IssuePriority;
  estimatedCompletionAt: number | null;
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 2: Add migration to migrations.ts**

Append after `backend_v26_deliverable` (id=5012):

```ts
{
  name: "backend_v27_issue_enrichment",
  id: 5013,
  up: `
    ALTER TABLE issue ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE issue ADD COLUMN priority TEXT NOT NULL DEFAULT 'P2';
    ALTER TABLE issue ADD COLUMN estimated_completion_at INTEGER;
  `,
},
```

- [ ] **Step 3: Run migration tests**

```bash
cd apps/backend && bun test --test-name-pattern="db"
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/issue/entities.ts apps/backend/src/infra/sqlite/migrations.ts
git commit -m "feat: add Issue enrichment fields (description, priority, estimatedCompletionAt)"
```

---

### Task C2: Update issue adapter and ports for new fields

**Files:**
- Modify: `apps/backend/src/features/issue/ports.ts`
- Modify: `apps/backend/src/features/issue/adapter-sqlite.ts`

- [ ] **Step 1: Read ports.ts first to understand current types**

Current `CreateIssueInput` only has `{issueId, projectId, title, threadId, createdAt}`. We need to add the new fields.

- [ ] **Step 2: Update ports.ts**

```ts
import type { IssuePriority, IssueRow } from "./entities.js";

export interface CreateIssueInput {
  issueId: string;
  projectId: string;
  title: string;
  threadId: string;
  description?: string;
  priority?: IssuePriority;
  estimatedCompletionAt?: number | null;
  createdAt: number;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  priority?: IssuePriority;
  estimatedCompletionAt?: number | null;
}

export interface IssuePort {
  createIssue(input: CreateIssueInput): IssueRow;
  getIssue(issueId: string): IssueRow | null;
  listIssues(opts?: { projectId?: string }): IssueRow[];
  setStatus(issueId: string, expectFrom: IssueStatus, to: IssueStatus, updatedAt: number): boolean;
  updateIssue(issueId: string, patch: UpdateIssueInput, updatedAt: number): IssueRow | null;
  deleteIssue(issueId: string): boolean;
}
```

- [ ] **Step 3: Update adapter-sqlite.ts**

Update `Raw` type to include new columns:
```ts
type Raw = {
  issue_id: string;
  project_id: string;
  title: string;
  status: IssueStatus;
  thread_id: string;
  description: string;
  priority: string;
  estimated_completion_at: number | null;
  created_at: number;
  updated_at: number;
};
```

Update `toRow` to map new fields:
```ts
const toRow = (r: Raw): IssueRow => ({
  issueId: r.issue_id,
  projectId: r.project_id,
  title: r.title,
  status: r.status,
  threadId: r.thread_id,
  description: r.description,
  priority: r.priority as IssueRow["priority"],
  estimatedCompletionAt: r.estimated_completion_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
```

Update `createIssue` INSERT to include new columns:
```ts
createIssue(input: CreateIssueInput): IssueRow {
  db.run(
    `INSERT INTO issue (issue_id, project_id, title, status, thread_id, description, priority, estimated_completion_at, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
    [
      input.issueId, input.projectId, input.title, input.threadId,
      input.description ?? "", input.priority ?? "P2", input.estimatedCompletionAt ?? null,
      input.createdAt, input.createdAt,
    ],
  );
  return { ...input, status: "draft", updatedAt: input.createdAt,
    description: input.description ?? "", priority: input.priority ?? "P2",
    estimatedCompletionAt: input.estimatedCompletionAt ?? null };
},
```

Add `updateIssue` and `deleteIssue`:
```ts
updateIssue(issueId: string, patch: UpdateIssueInput, updatedAt: number): IssueRow | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
  if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
  if (patch.priority !== undefined) { sets.push("priority = ?"); params.push(patch.priority); }
  if (patch.estimatedCompletionAt !== undefined) { sets.push("estimated_completion_at = ?"); params.push(patch.estimatedCompletionAt); }
  if (sets.length === 0) return this.getIssue(issueId);
  sets.push("updated_at = ?"); params.push(updatedAt);
  params.push(issueId);
  db.run(`UPDATE issue SET ${sets.join(", ")} WHERE issue_id = ?`, params);
  return this.getIssue(issueId);
},

deleteIssue(issueId: string): boolean {
  const { changes } = db.run("DELETE FROM issue WHERE issue_id = ?", [issueId]);
  return changes > 0;
},
```

- [ ] **Step 4: Run issue adapter tests**

```bash
cd apps/backend && bun test --test-name-pattern="adapter-sqlite"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/issue/ports.ts apps/backend/src/features/issue/adapter-sqlite.ts
git commit -m "feat: update issue adapter/ports for enrichment fields + PATCH/DELETE"
```

---

### Task C3: Update issue service for create/update/delete

**Files:**
- Modify: `apps/backend/src/features/issue/service.ts`

- [ ] **Step 1: Update createIssue signature**

```ts
createIssue(input: {
  projectId: string;
  title: string;
  description?: string;
  priority?: IssuePriority;
  estimatedCompletionAt?: number | null;
}): IssueRow {
  if (projectExists && !projectExists(input.projectId)) {
    throw new ValidationError(`project not found: ${input.projectId}`);
  }
  const issueId = idGen();
  const threadId = `issue:${issueId}`;
  return port.createIssue({
    issueId,
    projectId: input.projectId,
    title: input.title,
    threadId,
    description: input.description,
    priority: input.priority,
    estimatedCompletionAt: input.estimatedCompletionAt,
    createdAt: now(),
  });
},
```

- [ ] **Step 2: Add updateIssue and deleteIssue methods**

```ts
updateIssue(issueId: string, patch: {
  title?: string;
  description?: string;
  priority?: IssuePriority;
  estimatedCompletionAt?: number | null;
}): IssueRow {
  const updated = port.updateIssue(issueId, patch, now());
  if (!updated) throw new IssueNotFoundError(issueId);
  return updated;
},

deleteIssue(issueId: string): void {
  if (!port.deleteIssue(issueId)) throw new IssueNotFoundError(issueId);
},
```

- [ ] **Step 3: Run issue service tests**

```bash
cd apps/backend && bun test --test-name-pattern="issue.*service"
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/issue/service.ts
git commit -m "feat: add updateIssue/deleteIssue to issue service + enriched createIssue"
```

---

### Task C4: Add PATCH/DELETE HTTP endpoints for issues

**Files:**
- Modify: `apps/backend/src/features/issue/http.ts`

- [ ] **Step 1: Add PATCH and DELETE schemas + routes**

Add update schema:
```ts
const updateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  estimatedCompletionAt: z.number().nullable().optional(),
});
```

Add routes:
```ts
/** PATCH /api/issues/:id → 200 { issue } | 400 | 404 */
async update(req: Request, issueId: string): Promise<Response> {
  const parsed = updateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return json({ error: "Validation failed", details: parsed.error.issues }, 400);
  try {
    const issue = svc.updateIssue(issueId, parsed.data);
    return json({ issue });
  } catch (err) {
    if (err instanceof IssueNotFoundError) return json({ error: err.message }, 404);
    if (err instanceof ValidationError) return json({ error: err.message }, 400);
    throw err;
  }
},

/** DELETE /api/issues/:id → 204 | 404 */
remove(_req: Request, issueId: string): Response {
  try {
    svc.deleteIssue(issueId);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof IssueNotFoundError) return json({ error: err.message }, 404);
    throw err;
  }
},
```

- [ ] **Step 2: Update createSchema to include new fields**

```ts
const createSchema = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  estimatedCompletionAt: z.number().nullable().optional(),
});
```

Update create handler to pass new fields:
```ts
const issue = svc.createIssue(parsed.data);
```

- [ ] **Step 3: Run HTTP tests**

```bash
cd apps/backend && bun test --test-name-pattern="issue.*http"
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/issue/http.ts
git commit -m "feat: add PATCH/DELETE issue endpoints + enriched create schema"
```

---

### Task C5: Update detail endpoint to include new fields

**Files:**
- Modify: `apps/backend/src/features/issue/http.ts:283-302`

- [ ] **Step 1: Verify detail already returns full issue object**

The `detail()` method already returns `{ issue, timeline, runs }` where `issue` comes from `svc.port.getIssue()`. After C2/C3, `getIssue` already returns enriched fields. No code changes needed for the detail response itself.

- [ ] **Step 2: Run issue detail test**

```bash
cd apps/backend && bun test --test-name-pattern="detail"
```

Expected: PASS (issue object now includes description/priority/estimatedCompletionAt)

- [ ] **Step 3: Commit**

No commit needed — data flows through existing codepath.

---

## Part D — Handlebars + approval_posture + auto_orchestrate

### Task D1: Install Handlebars dependency

**Files:**
- Modify: `apps/backend/package.json`

- [x] **Step 1: Add handlebars dependency**

```bash
cd apps/backend && bun add handlebars
```

- [ ] **Step 2: Commit**

```bash
git add apps/backend/package.json apps/backend/bun.lock
git commit -m "feat: add handlebars dependency for prompt template rendering"
```

---

### Task D2: Rewrite render.ts with Handlebars sandbox

**Files:**
- Modify: `apps/backend/src/features/orchestrator/render.ts`

- [ ] **Step 1: Rewrite render.ts**

```ts
import Handlebars from "handlebars";

const hb = Handlebars.create();

const cache = new Map<string, Handlebars.TemplateDelegate>();

export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  try {
    let tpl = cache.get(template);
    if (!tpl) {
      tpl = hb.compile(template, {
        noEscape: true,
        strict: false,
        knownHelpersOnly: true,
      });
      cache.set(template, tpl);
    }
    return tpl(vars);
  } catch {
    return template;
  }
}
```

- [ ] **Step 2: Update PromptVars type**

Change `PromptVars` from `{ [k: string]: string | PromptVars }` to simply `Record<string, unknown>`:

```ts
/** Context passed to Handlebars templates. Keys are the variable names available in templates. */
export type PromptVars = Record<string, unknown>;
```

- [ ] **Step 3: Run render tests**

```bash
cd apps/backend && bun test --test-name-pattern="render"
```

Expected: All existing render tests PASS (Handlebars `{{path}}` syntax is identical to old regex)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/orchestrator/render.ts
git commit -m "feat: replace regex-based renderPrompt with sandboxed Handlebars"
```

---

### Task D3: Enrich buildPromptVars for Handlebars context

**Files:**
- Modify: `apps/backend/src/features/orchestrator/reactor.ts`

- [ ] **Step 1: Rewrite buildPromptVars**

```ts
function buildPromptVars(issue: IssueRow, deliverables: DeliverableRow[]): PromptVars {
  const byKind: Record<string, { fields: Record<string, string>; ref: string }> =
    Object.create(null);
  for (const d of deliverables) {
    byKind[d.kind] = { fields: d.fields, ref: d.ref ?? "" };
  }
  const isRework = !!byKind.rework_feedback;
  return {
    issue: {
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      id: issue.issueId,
      status: issue.status,
      estimatedCompletionAt: issue.estimatedCompletionAt,
    },
    deliverables: byKind,
    rework: { note: byKind.rework_feedback?.fields?.note ?? "" },
    attempt: isRework ? 2 : 1,
    isRework,
    // Backward-compatible flat keys
    title: issue.title,
    issueId: issue.issueId,
  };
}
```

- [ ] **Step 2: Run reactor tests**

```bash
cd apps/backend && bun test --test-name-pattern="reactor"
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/orchestrator/reactor.ts
git commit -m "feat: enrich buildPromptVars with Handlebars-compatible context (issue, rework, isRework)"
```

---

### Task D4: Add Handlebars-specific render tests

**Files:**
- Modify: `apps/backend/src/features/orchestrator/render.test.ts`

- [ ] **Step 1: Add test cases**

Add tests for:
- `{{#if isRework}}` conditional
- `{{#each deliverables}}` iteration
- Missing variable → empty string
- Bad template → return raw (not throw)
- `knownHelpersOnly` blocks unknown helpers

Read existing test file first to understand patterns, then add.

- [ ] **Step 2: Run tests**

```bash
cd apps/backend && bun test --test-name-pattern="render"
```

Expected: All PASS including new cases

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/orchestrator/render.test.ts
git commit -m "test: add Handlebars conditional/loop/error test cases for renderPrompt"
```

---

### Task D5: Add approval_posture to ColumnConfig

**Files:**
- Modify: `apps/backend/src/features/column-config/domain.ts`
- Modify: `apps/backend/src/features/column-config/ports.ts`
- Modify: `apps/backend/src/features/column-config/adapter-sqlite.ts`
- Modify: `apps/backend/src/infra/sqlite/migrations.ts`

- [ ] **Step 1: Add type and migration**

In `domain.ts`, add to `ColumnConfigRow`:
```ts
approvalPosture: "auto" | "human";
```

In `migrations.ts`, add after `backend_v27_issue_enrichment` (id=5013):
```ts
{
  name: "backend_v28_column_config_approval_posture",
  id: 5014,
  up: `ALTER TABLE column_config ADD COLUMN approval_posture TEXT NOT NULL DEFAULT 'auto';`,
},
```

- [ ] **Step 2: Update ports.ts**

Add `approvalPosture?: "auto" | "human"` to `CreateColumnConfigRecord`.

- [ ] **Step 3: Update adapter-sqlite.ts**

Update `Raw` type, `toRow`, `upsert` INSERT/UPDATE to include `approval_posture` column. Default `'auto'`.

- [ ] **Step 4: Run column-config tests**

```bash
cd apps/backend && bun test
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/column-config/domain.ts apps/backend/src/features/column-config/ports.ts apps/backend/src/features/column-config/adapter-sqlite.ts apps/backend/src/infra/sqlite/migrations.ts
git commit -m "feat: add approval_posture column to column_config"
```

---

### Task D6: Wire approval_posture into transitions/nextTransition

**Files:**
- Modify: `apps/backend/src/features/orchestrator/transitions.ts`
- Modify: `apps/backend/src/features/column-config/service.ts`

- [ ] **Step 1: Add approvalPosture to Transition interface**

```ts
export interface Transition {
  from: IssueStatus;
  to: IssueStatus;
  agentId: string;
  promptTemplate: string;
  approvalPosture: "auto" | "human";  // NEW
}
```

- [ ] **Step 2: Update nextTransition to check approvalPosture**

```ts
export function nextTransition(
  table: ReadonlyArray<Transition>,
  from: IssueStatus,
): Transition | undefined {
  const t = table.find((t) => t.from === from);
  if (!t) return undefined;
  if (t.approvalPosture === "human") return undefined; // gate — don't auto-advance
  if (HUMAN_GATES.has(from) && t.approvalPosture === "auto") return undefined; // safety: HUMAN_GATES still blocks auto by default
  return t;
}
```

Wait — let me reconsider. The spec says: `nextTransition` gate determination changes from `HUMAN_GATES.has(from)` to `approvalPosture==='human'`, with `HUMAN_GATES` as fallback default when no config.

Actually, the spec decision Q3 says "B: add column + reactor reads column for gate, HUMAN_GATES drops to fallback default". So:

```ts
export function nextTransition(
  table: ReadonlyArray<Transition>,
  from: IssueStatus,
): Transition | undefined {
  const t = table.find((t) => t.from === from);
  if (!t) return undefined;
  // If a Transition exists with explicit approvalPosture, use that.
  // Otherwise fall back to HUMAN_GATES for backward compatibility.
  if (t.approvalPosture === "human") return undefined;
  return t;
}
```

Wait but `nextTransition` currently filters by `HUMAN_GATES` BEFORE the table is even consulted. The current flow is:

1. `nextTransition(table, from)`: check `HUMAN_GATES.has(from)` → return undefined
2. Otherwise find `table.find(t => t.from === from)` → if found, return it

AND `transitionsForProject` (in column-config/service.ts) already skips `HUMAN_GATES`:
```ts
if (HUMAN_GATES.has(from)) continue; // gate columns never auto-advance
```

So `in_review` columns never appear in the Transition[] at all. To wire `approval_posture`, we need to:

1. In `transitionsForProject`: STOP skipping `HUMAN_GATES` — include `in_review` if it has a ColumnConfig
2. In `nextTransition`: check `approvalPosture === "human"` to gate
3. `HUMAN_GATES` as fallback when no Transition exists for a status

Let me write the actual code:

In `column-config/service.ts` `transitionsForProject`:
```ts
transitionsForProject(projectId: string): Transition[] {
  const byStatus = new Map(port.listByProject(projectId).map((c) => [c.status, c]));
  const out: Transition[] = [];
  for (let i = 0; i < ORDER.length - 1; i++) {
    const from = ORDER[i]!;
    const to = ORDER[i + 1]!;
    // M19: no longer skip HUMAN_GATES here — approval_posture drives gating
    // in nextTransition(). Include all configured columns.
    const cfg = byStatus.get(from);
    if (!cfg) continue;
    out.push({
      from, to,
      agentId: cfg.agentId,
      promptTemplate: cfg.promptTemplate,
      approvalPosture: cfg.approvalPosture,
    });
  }
  return out;
},
```

In `transitions.ts` `nextTransition`:
```ts
export function nextTransition(
  table: ReadonlyArray<Transition>,
  from: IssueStatus,
): Transition | undefined {
  const t = table.find((t) => t.from === from);
  if (!t) {
    // No config for this status — use hardcoded HUMAN_GATES as fallback
    if (HUMAN_GATES.has(from)) return undefined;
    return undefined; // no config = no auto-advance
  }
  // Config exists — approval_posture drives gating
  if (t.approvalPosture === "human") return undefined;
  return t;
}
```

This preserves default behavior: `in_review` defaults to `approval_posture='human'` in the column (from the ColumnConfigPanel UI default), so reactor still won't auto-advance it. But if someone explicitly sets `approval_posture='auto'` for `in_review`, it WILL auto-advance.

- [ ] **Step 2: Run transitions tests**

```bash
cd apps/backend && bun test --test-name-pattern="transitions"
```

Expected: PASS (default behavior unchanged)

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/orchestrator/transitions.ts apps/backend/src/features/column-config/service.ts
git commit -m "feat: wire approval_posture into transitions — column-config drives gate, HUMAN_GATES as fallback"
```

---

### Task D7: Add auto_orchestrate to Project

**Files:**
- Modify: `apps/backend/src/features/project/domain.ts`
- Modify: `apps/backend/src/features/project/ports.ts`
- Modify: `apps/backend/src/features/project/adapter-sqlite.ts`
- Modify: `apps/backend/src/features/project/service.ts`
- Modify: `apps/backend/src/features/project/http.ts`
- Modify: `apps/backend/src/infra/sqlite/migrations.ts`

- [ ] **Step 1: Add to domain, ports, migration**

In `domain.ts`:
```ts
export interface ProjectRow {
  // ...existing...
  autoOrchestrate: boolean;
}
```

In `migrations.ts`:
```ts
{
  name: "backend_v29_project_auto_orchestrate",
  id: 5015,
  up: `ALTER TABLE project ADD COLUMN auto_orchestrate INTEGER NOT NULL DEFAULT 0;`,
},
```

In `ports.ts`:
```ts
export interface CreateProjectRecord {
  // ...existing...
  autoOrchestrate?: boolean;
}
export interface UpdateProjectRecord {
  // ...existing...
  autoOrchestrate?: boolean;
}
```

- [ ] **Step 2: Update adapter-sqlite.ts**

Update `Raw` type with `auto_orchestrate: number`, `toRow` to map `auto_orchestrate === 1`, `createProject` INSERT to include column, `updateProject` to support patching it.

- [ ] **Step 3: Update service.ts**

```ts
createProject(input: {
  name: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
  autoOrchestrate?: boolean;
}): ProjectRow { ... }

update(id: string, patch: {
  name?: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
  autoOrchestrate?: boolean;
}): ProjectRow { ... }
```

- [ ] **Step 4: Update http.ts**

Add `autoOrchestrate: z.boolean().optional()` to both `createSchema` and `updateSchema`.

- [ ] **Step 5: Run tests**

```bash
cd apps/backend && bun test
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/features/project/domain.ts apps/backend/src/features/project/ports.ts apps/backend/src/features/project/adapter-sqlite.ts apps/backend/src/features/project/service.ts apps/backend/src/features/project/http.ts apps/backend/src/infra/sqlite/migrations.ts
git commit -m "feat: add auto_orchestrate column to project (default off)"
```

---

### Task D8: Wire auto_orchestrate into reactor

**Files:**
- Modify: `apps/backend/src/features/orchestrator/reactor.ts`
- Modify: `apps/backend/src/main.ts`

- [ ] **Step 1: Add projectSvc to OrchestratorDeps**

```ts
export interface OrchestratorDeps {
  // ...existing fields...
  projectSvc: { getById(id: string): { autoOrchestrate: boolean; projectId: string } };
}
```

- [ ] **Step 2: Add guard at top of onRunComplete**

After confirming `origin?.originKind === "orchestrator"` and `origin.issueId`:

```ts
const issueId = origin.issueId;
const issue = issueSvc.port.getIssue(issueId);
if (!issue) return;

// Auto-orchestrate guard: if off, skip state machine entirely.
// Run still lands in ledger/Coding Thread via projection.
const project = await projectSvc.getById(issue.projectId).catch(() => null);
if (!project?.autoOrchestrate) return;
```

- [ ] **Step 3: Inject projectSvc in main.ts**

In `main.ts:330`, add to createOrchestrator call:

```ts
const orchestrator = createOrchestrator({
  // ...existing...
  projectSvc,  // already constructed at line 288
});
```

- [ ] **Step 4: Run tests**

```bash
cd apps/backend && bun test --test-name-pattern="reactor"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/orchestrator/reactor.ts apps/backend/src/main.ts
git commit -m "feat: reactor checks project.autoOrchestrate — off skips auto-advance"
```

---

## Part E — Read-Only Issue Tools

### Task E1: Add read_issues capability

**Files:**
- Modify: `apps/backend/src/features/run/supervisor.ts`
- Modify: `apps/backend/src/features/orchestrator/reactor.ts`

- [ ] **Step 1: Add to capability union in supervisor.ts:46**

```ts
capabilities: Array<"start_new_conversation" | "submit_deliverable" | "read_issues">;
```

- [ ] **Step 2: Update reactor startStep to include read_issues**

In `reactor.ts` `startStep`, change capabilities from `["submit_deliverable"]` to `["submit_deliverable", "read_issues"]`.

- [ ] **Step 3: Run typecheck**

```bash
cd apps/backend && bun run typecheck
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/run/supervisor.ts apps/backend/src/features/orchestrator/reactor.ts
git commit -m "feat: add read_issues capability to supervisor + orchestrator"
```

---

### Task E2: Create get_issue and list_issues tools in runner-daemon

**Files:**
- Create: `packages/runner-daemon/src/get-issue-tool.ts`
- Create: `packages/runner-daemon/src/list-issues-tool.ts`
- Modify: `packages/runner-daemon/src/runner-daemon.ts`
- Modify: `packages/runner-daemon/src/index.ts` (if barrel exports)

- [ ] **Step 1: Read existing submit-deliverable tool for pattern**

Read `packages/runner-daemon/src/submit-deliverable-tool.ts` (or similar) to understand the tool creation pattern. Then create `get-issue-tool.ts` and `list-issues-tool.ts` following the same pattern: HTTP GET to backend `/api/bff/issues/:id` and `/api/bff/issues?projectId=`.

- [ ] **Step 2: Inject tools in runner-daemon.ts**

After the submit_deliverable injection block (~line 200), add:

```ts
if (sc?.capabilities.includes("read_issues") && sc.issue && spec.mode !== "reflect") {
  try {
    extraTools.push(createGetIssueTool({
      backendUrl: this.#backendUrl,
      backendAuthToken: this.#backendAuthToken,
      issueId: sc.issue.issueId,
    }));
    extraTools.push(createListIssuesTool({
      backendUrl: this.#backendUrl,
      backendAuthToken: this.#backendAuthToken,
    }));
  } catch (err) {
    extraTools.push({
      name: "get_issue",
      description: "Read issue details (tool injection failed)",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({ isError: true, content: [{ type: "text", text: `Failed to inject get_issue: ${err instanceof Error ? err.message : String(err)}` }] }),
    } as Tool);
  }
}
```

- [ ] **Step 3: Run runner-daemon tests**

```bash
cd packages/runner-daemon && bun test
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/runner-daemon/src/get-issue-tool.ts packages/runner-daemon/src/list-issues-tool.ts packages/runner-daemon/src/runner-daemon.ts
git commit -m "feat: add read-only get_issue/list_issues tools for issue runs"
```

---

## Part F — Issue ↔ Conversation Projection + Coding Thread

### Task F1: Add conversation.origin column

**Files:**
- Modify: `apps/backend/src/features/conversation/ports.ts`
- Modify: `apps/backend/src/features/conversation/adapter-sqlite.ts`
- Modify: `apps/backend/src/infra/sqlite/migrations.ts`

- [ ] **Step 1: Add migration**

```ts
{
  name: "backend_v30_conversation_origin",
  id: 5016,
  up: `ALTER TABLE conversation ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';`,
},
```

- [ ] **Step 2: Update types**

`CreateConversationInput` add `origin?: string`.
`ConversationRow` add `origin: string`.

- [ ] **Step 3: Update adapter-sqlite.ts**

`createConversation` INSERT includes `origin`, `listConversations` adds `WHERE origin = 'user'`, `getConversation`/`listConversationsByAgent` no filter. `toRow` maps `origin`.

- [ ] **Step 4: Run conversation tests**

```bash
cd apps/backend && bun test --test-name-pattern="conversation"
```

Expected: PASS (default 'user' for existing calls)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/conversation/ports.ts apps/backend/src/features/conversation/adapter-sqlite.ts apps/backend/src/infra/sqlite/migrations.ts
git commit -m "feat: add conversation.origin column ('user'|'issue') + filter user conversations from list"
```

---

### Task F2: Create issue conversation on issue creation

**Files:**
- Modify: `apps/backend/src/features/issue/service.ts`
- Modify: `apps/backend/src/main.ts`

- [ ] **Step 1: Update IssueServiceDeps to accept conversation port**

```ts
export interface IssueServiceDeps {
  port: IssuePort;
  idGen: () => string;
  now?: () => number;
  projectExists?: (projectId: string) => boolean;
  convPort?: ConversationPort;  // NEW — for creating issue-side conversation
}
```

- [ ] **Step 2: In createIssue, after creating the issue, create conversation**

```ts
createIssue(input: { ... }): IssueRow {
  // ...existing validation and issue creation...
  const issue = port.createIssue({ ... });

  // Create issue-side conversation for Coding Thread
  if (deps.convPort) {
    try {
      deps.convPort.createConversation({
        conversationId: issueId,
        triggerMode: "mention",
        origin: "issue",  // NEW field
        createdAt: now(),
      });
      deps.convPort.setConversationTitle(issueId, issue.title);
      deps.convPort.addMember({
        memberId: "owner",
        conversationId: issueId,
        kind: "human",
        displayName: "Owner",
        joinedAt: now(),
      });
    } catch {
      // best-effort — issue creation succeeds even if conversation setup fails
    }
  }

  return issue;
},
```

- [ ] **Step 3: Wire convPort in main.ts**

In `main.ts`, pass `convPort: conv.convPort` to `createIssueService`.

- [ ] **Step 4: Run tests**

```bash
cd apps/backend && bun test
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/issue/service.ts apps/backend/src/main.ts
git commit -m "feat: create issue-side conversation on issue creation for Coding Thread"
```

---

### Task F3: Change issue threadId format + remove issue: shortcuts

**Files:**
- Modify: `apps/backend/src/features/issue/service.ts`
- Modify: `apps/backend/src/features/orchestrator/reactor.ts`
- Modify: `apps/backend/src/main.ts`

- [ ] **Step 1: Change threadId format in issue creation**

In `service.ts` `createIssue`, change:
```ts
// BEFORE:
const threadId = `issue:${issueId}`;
// AFTER:
const threadId = `${issueId}:owner`;  // conversationId=issueId, memberId="owner"
```

- [ ] **Step 2: Update reactor startStep threadId**

In `reactor.ts` `startStep`, change `issue.threadId` usage. The threadId should now be `issueId:agentId` to match the conversation projection pattern:

```ts
const threadId = `${issue.issueId}:${t.agentId}`;
const spec = await buildSpec(t.agentId, threadId, prompt);
```

- [ ] **Step 3: Remove issue: shortcuts in main.ts**

Remove three lines:
- Line ~141: `if (threadId.startsWith("issue:")) return;` (onRunComplete)
- Line ~162: `if (threadId.startsWith("issue:")) return;` (onRunMessage)
- Line ~222: `if (threadId.startsWith("issue:")) return;` (onRunEvent)

- [ ] **Step 4: Run full backend tests**

```bash
cd apps/backend && bun test
```

Expected: PASS. Issue runs now flow through projection.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/issue/service.ts apps/backend/src/features/orchestrator/reactor.ts apps/backend/src/main.ts
git commit -m "feat: change issue threadId to conversation format, remove issue: shortcuts — issue runs now flow through projection"
```

---

### Task F4: Lazy-add agent members to issue conversation

**Files:**
- Modify: `apps/backend/src/features/orchestrator/reactor.ts`

- [ ] **Step 1: Add member before dispatch in startStep**

Before `dispatcher.dispatch`, add:
```ts
// Lazy-add agent member to issue conversation (idempotent INSERT OR IGNORE)
if (convPort) {
  convPort.addMember({
    memberId: t.agentId,
    conversationId: issue.issueId,
    kind: "agent",
    agentId: t.agentId,
    displayName: agent.name,
    joinedAt: (deps.now ?? Date.now)(),
  });
}
```

- [ ] **Step 2: Add convPort to OrchestratorDeps**

```ts
convPort?: { addMember(input: {
  memberId: string; conversationId: string; kind: "agent" | "human";
  agentId?: string; displayName?: string; joinedAt: number;
}): { created: boolean } };
```

- [ ] **Step 3: Wire in main.ts**

Pass `convPort: conv.convPort` to orchestrator.

- [ ] **Step 4: Run tests**

```bash
cd apps/backend && bun test
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/orchestrator/reactor.ts apps/backend/src/main.ts
git commit -m "feat: lazy-add agent members to issue conversation before dispatch"
```

---

### Task F5: Add Coding Thread read endpoint + DELETE cascade

**Files:**
- Modify: `apps/backend/src/features/issue/http.ts`
- Modify: `apps/backend/src/features/issue/service.ts`
- Modify: `apps/backend/src/features/issue/ports.ts`

- [ ] **Step 1: Add getIssueThread endpoint**

In `http.ts`:
```ts
/** GET /api/issues/:id/thread → 200 { entries } */
thread(_req: Request, issueId: string): Response {
  const issue = svc.port.getIssue(issueId);
  if (!issue) return json({ error: "Not found" }, 404);
  const entries = svc.port.getLedgerEntries?.(issueId) ?? [];
  return json({ entries });
},
```

- [ ] **Step 2: Update IssuePort interface**

Add optional method:
```ts
getLedgerEntries?: (conversationId: string) => LedgerEntry[];
```

- [ ] **Step 3: Wire DELETE to cascade conversation deletion**

In `issue/http.ts` `remove`:
```ts
remove(_req: Request, issueId: string): Response {
  try {
    svc.deleteIssue(issueId);
    // Cascade delete issue-side conversation
    svc.port.deleteConversation?.(issueId);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof IssueNotFoundError) return json({ error: err.message }, 404);
    throw err;
  }
},
```

Add `deleteConversation?` to IssuePort.

- [ ] **Step 4: Wire in main.ts adapter**

In the `sqliteIssueAdapter`, add `conversationAdapter` dependency to provide `getLedgerEntries` and `deleteConversation`.

- [ ] **Step 5: Run tests**

```bash
cd apps/backend && bun test
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/features/issue/http.ts apps/backend/src/features/issue/service.ts apps/backend/src/features/issue/ports.ts apps/backend/src/features/issue/adapter-sqlite.ts
git commit -m "feat: add Coding Thread read endpoint + DELETE cascade for issue conversation"
```

---

## Part G — Frontend Feature Increments

### Task G1: Update frontend API types for new fields

**Files:**
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Update IssueRow type**

```ts
export type IssuePriority = "P0" | "P1" | "P2" | "P3";

export interface IssueRow {
  issueId: string;
  projectId: string;
  title: string;
  status: IssueStatus;
  threadId: string;
  description: string;
  priority: IssuePriority;
  estimatedCompletionAt: number | null;
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 2: Add new API methods**

```ts
updateIssue: (id: string, body: {
  title?: string; description?: string; priority?: IssuePriority; estimatedCompletionAt?: number | null;
}) => apiFetch<{ issue: IssueRow }>(`issues/${id}`, { method: "PATCH", body }),

deleteIssue: (id: string) => apiFetch<void>(`issues/${id}`, { method: "DELETE" }),

getIssueThread: (id: string) => apiFetch<{ entries: LedgerEntry[] }>(`issues/${id}/thread`),
```

- [ ] **Step 3: Update createIssue method**

```ts
createIssue: (body: {
  projectId: string; title: string; description?: string;
  priority?: IssuePriority; estimatedCompletionAt?: number | null;
}) => apiFetch<{ issue: IssueRow }>("issues", { method: "POST", body }),
```

- [ ] **Step 4: Update ProjectRow for autoOrchestrate**

```ts
export interface ProjectRow {
  projectId: string;
  name: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  autoOrchestrate: boolean;
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 5: Update updateProject API**

```ts
updateProject: (id: string, body: {
  name?: string; repoUrl?: string | null; defaultBranch?: string | null;
  autoOrchestrate?: boolean;
}) => apiFetch<{ project: ProjectRow }>(`projects/${id}`, { method: "PATCH", body }),
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat: update frontend API types for M19 enriched fields + new endpoints"
```

---

### Task G2: Hide draft column in kanban + card priority badge + description

**Files:**
- Modify: `apps/web/src/components/IssueKanban.tsx`
- Modify: `apps/web/src/components/IssueCard.tsx`

- [ ] **Step 1: Filter out draft from kanban columns**

In `IssueKanban.tsx`, filter `statuses` prop:
```tsx
const boardStatuses = statuses.filter(s => s !== "draft");
```

Use `boardStatuses` instead of `statuses` for column rendering.

- [ ] **Step 2: Add priority badge to IssueCard**

After the `IssueStatusBadge`, add:
```tsx
import { Badge } from "@/components/ui/badge";

// Color mapping
const PRIORITY_COLORS: Record<string, string> = {
  P0: "bg-red-600 text-white",
  P1: "bg-orange-500 text-white",
  P2: "bg-blue-500 text-white",
  P3: "bg-gray-400 text-white",
};

// In card body:
<Badge className={PRIORITY_COLORS[issue.priority] ?? ""}>{issue.priority}</Badge>
```

- [ ] **Step 3: Add description summary to card**

If `issue.description` is non-empty, show truncated text:
```tsx
{issue.description && (
  <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{issue.description}</p>
)}
```

- [ ] **Step 4: Run frontend build**

```bash
cd apps/web && bun run build 2>&1 | head -20
```

Check for compile errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/IssueKanban.tsx apps/web/src/components/IssueCard.tsx
git commit -m "feat: hide draft column, add priority badge and description to IssueCard"
```

---

### Task G3: Add auto-orchestrate toggle to kanban header

**Files:**
- Create/Modify: `apps/web/src/components/IssueKanban.tsx` (add header section above columns)
- Read: `apps/web/src/app/(main)/issues/page.tsx` (to understand project context)

- [ ] **Step 1: Add toggle component in kanban header**

Read `apps/web/src/app/(main)/issues/page.tsx` to understand the page structure and where the project selector is.

Add a toggle bar above the kanban columns:

```tsx
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

// In the kanban component, add a header bar:
<div className="px-6 pt-4 flex items-center gap-4">
  <div className="flex items-center gap-2">
    <span className="text-sm font-medium">自动推进</span>
    <span className="text-xs text-muted-foreground">Orchestra Beta</span>
  </div>
  {project?.autoOrchestrate ? (
    <span className="text-xs text-green-600">已启用</span>
  ) : (
    <Button
      size="sm"
      variant="outline"
      className="text-xs"
      onClick={async () => {
        await api.updateProject(projectId, { autoOrchestrate: true });
        // refresh project context
      }}
    >
      开始使用 →
    </Button>
  )}
  {project?.autoOrchestrate && (
    <Switch
      checked={project.autoOrchestrate}
      onCheckedChange={async (v) => {
        await api.updateProject(projectId, { autoOrchestrate: v });
        // refresh
      }}
    />
  )}
</div>
```

- [ ] **Step 2: Read issues/page.tsx to integrate project state**

Read the page to understand how projects are fetched and which project is active. Then integrate the toggle with the active project's `autoOrchestrate` state.

- [ ] **Step 3: Run frontend build check**

```bash
cd apps/web && bun run build 2>&1 | head -30
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/IssueKanban.tsx apps/web/src/app/(main)/issues/page.tsx
git commit -m "feat: add auto-orchestrate toggle to kanban header"
```

---

### Task G4: Convert IssueDetailSheet from Dialog to right-side Sheet

**Files:**
- Modify: `apps/web/src/components/IssueDetailSheet.tsx`

- [ ] **Step 1: Read ColumnConfigPanel for Sheet pattern reference**

Read `apps/web/src/components/ColumnConfigPanel.tsx` to understand the existing Sheet pattern (imports, structure, header styling).

- [ ] **Step 2: Rewrite IssueDetailSheet with Sheet**

Replace `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle` with `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle`:

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

// Replace the Dialog with:
<Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
  <SheetContent side="right" className="w-[480px] sm:max-w-[540px] overflow-y-auto">
    <SheetHeader>
      <SheetTitle className="flex items-center gap-2">
        {issue.title}
        <IssueStatusBadge status={issue.status} />
      </SheetTitle>
    </SheetHeader>
    {/* ...existing content sections... */}
  </SheetContent>
</Sheet>
```

- [ ] **Step 3: Add action buttons (edit, delete)**

Add to SheetHeader:
```tsx
<div className="flex gap-2">
  <Button size="sm" variant="outline" onClick={() => setEditing(true)}>编辑</Button>
  <Button size="sm" variant="destructive" onClick={handleDelete}>删除</Button>
</div>
```

- [ ] **Step 4: Add Coding Thread card section**

After the meta section, add a section showing ledger entries from `getIssueThread`:

```tsx
{/* Coding Thread */}
<div className="mb-4">
  <h3 className="text-sm font-medium mb-2">Coding Thread</h3>
  {threadEntries.length === 0 ? (
    <p className="text-xs text-muted-foreground">暂无编码记录</p>
  ) : (
    threadEntries.map((entry) => (
      <Card key={entry.seq} className="mb-2">
        <CardContent className="p-2 text-xs">
          {entry.kind === "message" ? parseMessagePreview(entry.content) : entry.kind}
        </CardContent>
      </Card>
    ))
  )}
</div>
```

- [ ] **Step 5: Add status advance buttons**

```tsx
{/* Status advance buttons */}
<div className="flex gap-2 mb-4">
  {legalTransitions.map((toStatus) => (
    <Button key={toStatus} size="sm" variant="outline"
      onClick={() => api.applyTransition(issue.issueId, toStatus)}>
      移动到 {toStatus}
    </Button>
  ))}
</div>
```

- [ ] **Step 6: Add property table with new fields**

```tsx
{/* Property table */}
<div className="text-xs space-y-1 mb-4">
  <div>状态: <IssueStatusBadge status={issue.status} /></div>
  <div>优先级: <Badge>{issue.priority}</Badge></div>
  <div>创建时间: {new Date(issue.createdAt).toLocaleString()}</div>
  <div>预计完成: {issue.estimatedCompletionAt ? new Date(issue.estimatedCompletionAt).toLocaleDateString() : "未填写"}</div>
  {issue.description && <div>描述: {issue.description}</div>}
  <div>Token 用量: {formatTokens(totalTokens)}</div>
</div>
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/IssueDetailSheet.tsx
git commit -m "feat: convert IssueDetailSheet to right-side Sheet with Coding Thread, edit/delete, property table"
```

---

### Task G5: Fix Select displayName (D13)

**Files:**
- Modify: `apps/web/src/components/ui/select.tsx`
- Modify: `apps/web/src/app/(main)/issues/page.tsx`
- Modify: `apps/web/src/components/ColumnConfigPanel.tsx`

- [ ] **Step 1: Read current select.tsx**

Read `apps/web/src/components/ui/select.tsx` to understand the current `SelectValue` wrapper.

- [ ] **Step 2: Add label mapping support to SelectValue**

Update `SelectValue` to accept an optional `labelMap` or children render function that maps value→displayName:

```tsx
// In select.tsx, export a new component or update SelectValue:
export function SelectValueWithLabel({
  placeholder, labelMap,
}: {
  placeholder?: string;
  labelMap?: Record<string, string>;
}) {
  return (
    <SelectValue placeholder={placeholder}>
      {(value: string) => labelMap?.[value] ?? value}
    </SelectValue>
  );
}
```

Wait, base-ui's `Select.Value` children render prop might be different. Let me check the actual implementation. Read the file first.

- [ ] **Step 3: Fix project selector in issues/page.tsx**

Build a `projectLabelMap: Record<string, string>` from `projects` data, then use it:
```tsx
const projectLabelMap = Object.fromEntries(
  projects.map(p => [p.projectId, p.name])
);
<SelectValueWithLabel placeholder="选择项目" labelMap={projectLabelMap} />
```

- [ ] **Step 4: Fix agent selector in ColumnConfigPanel.tsx**

Similarly build agent label map:
```tsx
const agentLabelMap = Object.fromEntries(
  agents.map(a => [a.id, a.archivedAt ? `${a.name} (已归档)` : a.name])
);
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/select.tsx apps/web/src/app/(main)/issues/page.tsx apps/web/src/components/ColumnConfigPanel.tsx
git commit -m "fix: Select displays displayName instead of id (D13)"
```

---

### Task G6: Update create issue form with new fields

**Files:**
- Modify: `apps/web/src/app/(main)/issues/page.tsx`

- [ ] **Step 1: Add description/priority/estimatedCompletionAt fields to create form**

Read the existing form, then add:
- `description` textarea
- `priority` select (P0-P3)
- `estimatedCompletionAt` date input (optional)

- [ ] **Step 2: Run build check**

```bash
cd apps/web && bun run build 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/(main)/issues/page.tsx
git commit -m "feat: add description/priority/ETA fields to issue create form"
```

---

### Task G7: Final integration test + full suite

- [ ] **Step 1: Run full backend test suite**

```bash
cd apps/backend && bun test
```

Expected: All PASS

- [ ] **Step 2: Run full typecheck**

```bash
bun run typecheck
```

Expected: PASS

- [ ] **Step 3: Run full lint**

```bash
bun run lint
```

Expected: PASS

- [ ] **Step 4: Run full build**

```bash
bun run build
```

Expected: PASS

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: M19 — unified dispatcher, issue enrichment, Handlebars prompts, Coding Thread, kanban enhancements"
```
