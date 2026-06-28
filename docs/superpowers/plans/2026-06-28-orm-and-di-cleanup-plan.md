# ORM 归位 + DI 瘦身 — 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 S1 合库后遗留的 11 处原始 SQL 转为 drizzle ORM + 消除 3 处 db/opsStore DI 冗余 + 删除 1 处死代码。

**Architecture:** 自底向上：先给 RuntimeOpsStore 补方法 → 再改调用方（supervisor → service → conv-svc-factory → agent-svc-factory）→ 最后删死代码和冗余参数。

**Tech Stack:** TypeScript, bun:sqlite, drizzle-orm, bun:test

---

### Task 1: RuntimeOpsStore 补 3 个方法

**Files:**
- Modify: `apps/backend/src/features/runtime-ops/store.ts`

- [ ] **Step 1.1: Add `getRunBySpanId`**

```typescript
// 在 getRuns() 方法之后添加
getRunBySpanId(spanId: string): {
  spanId: string;
  sessionId: string;
  agentId: string;
  status: string;
  kind: string;
  parentSpanId: string | null;
  startedAt: number;
  endedAt: number | null;
} | null {
  const row = this.#d
    .select()
    .from(schema.run)
    .where(eq(schema.run.spanId, spanId))
    .get();
  if (!row) return null;
  return {
    spanId: row.spanId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    status: row.status,
    kind: row.kind,
    parentSpanId: row.parentSpanId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}
```

- [ ] **Step 1.2: Add `getSessionIdBySpanId`**

```typescript
getSessionIdBySpanId(spanId: string): string | null {
  const row = this.#d
    .select({ sessionId: schema.run.sessionId })
    .from(schema.run)
    .where(eq(schema.run.spanId, spanId))
    .get();
  return row?.sessionId ?? null;
}
```

- [ ] **Step 1.3: Add `deleteRunsBySession`**

```typescript
deleteRunsBySession(sessionId: string): void {
  this.#d.transaction(async (tx) => {
    // Delete attempts first (FK cascade may not cover all cases)
    tx.delete(schema.attempt)
      .where(
        inArray(
          schema.attempt.spanId,
          tx.select({ spanId: schema.run.spanId })
            .from(schema.run)
            .where(eq(schema.run.sessionId, sessionId)),
        ),
      )
      .run();
    tx.delete(schema.run)
      .where(eq(schema.run.sessionId, sessionId))
      .run();
  });
}
```

- [ ] **Step 1.4: Run typecheck + test**

```bash
cd apps/backend && bun run typecheck && bun test --test-name-pattern="RuntimeOpsStore"
```
Expected: PASS

- [ ] **Step 1.5: Commit**

```bash
git commit -m "feat(backend): add getRunBySpanId, getSessionIdBySpanId, deleteRunsBySession to RuntimeOpsStore"
```

---

### Task 2: supervisor.ts — 6 处原始 SQL → drizzle

**Files:**
- Modify: `apps/backend/src/features/span/supervisor.ts`

- [ ] **Step 2.1: Add drizzle imports and instance**

```typescript
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
```

Add to class:
```typescript
#d: ReturnType<typeof drizzle<typeof schema>>;

// In constructor:
this.#d = drizzle(opts.db, { schema, casing: "snake_case" });
```

- [ ] **Step 2.2: Add `getDrizzle()` method**

```typescript
getDrizzle(): ReturnType<typeof drizzle<typeof schema>> {
  return this.#d;
}
```

- [ ] **Step 2.3: Convert `#reapStaleRuns`**

Before:
```ts
const orphans = this.#db.query("SELECT a.span_id, a.seq, r.session_id, r.kind FROM attempt a JOIN run r ...").all()
```
After:
```ts
const orphans = this.#d
  .select({ spanId: schema.attempt.spanId, seq: schema.attempt.seq, sessionId: schema.run.sessionId, kind: schema.run.kind })
  .from(schema.attempt)
  .innerJoin(schema.run, eq(schema.attempt.spanId, schema.run.spanId))
  .where(and(isNull(schema.attempt.endedAt), isNull(schema.run.endedAt)))
  .all();
```
Update field refs: `row.span_id` → `row.spanId`, `row.session_id` → `row.sessionId`

- [ ] **Step 2.4: Convert `#finalizeRun` — async drizzle transaction**

```typescript
async #finalizeRun(spanId: string, attemptSeq: number | null, status: string): Promise<boolean> {
  const now = Date.now();
  const result = await this.#d.transaction(async (tx) => {
    const r = tx.update(schema.run)
      .set({ status, endedAt: now })
      .where(and(eq(schema.run.spanId, spanId), isNull(schema.run.endedAt)))
      .run();
    if (attemptSeq != null) {
      tx.update(schema.attempt)
        .set({ endedAt: now })
        .where(and(eq(schema.attempt.spanId, spanId), eq(schema.attempt.seq, attemptSeq), isNull(schema.attempt.endedAt)))
        .run();
    }
    return r.changes;
  });
  return result > 0;
}
```
Add `await` at call site in `#reapStaleRuns`.

- [ ] **Step 2.5: Convert `#markProjectionDegraded`**

```typescript
this.#d.update(schema.run)
  .set({ degradedReason: reason })
  .where(and(eq(schema.run.spanId, spanId), isNull(schema.run.degradedReason)))
  .run();
```

- [ ] **Step 2.6: Convert `startMainRun`**

```typescript
const seq = await this.#d.transaction(async (tx) => {
  await tx.insert(schema.run).values({ spanId, sessionId, status: "running", startedAt: now }).run();
  const rows = tx.select({ maxSeq: schema.attempt.seq }).from(schema.attempt).where(eq(schema.attempt.spanId, spanId)).all();
  const maxSeq = rows.reduce((max, r) => Math.max(max, r.maxSeq ?? 0), 0);
  const nextSeq = maxSeq + 1;
  await tx.insert(schema.attempt).values({ spanId, seq: nextSeq, startedAt: now }).run();
  return nextSeq;
});
```

- [ ] **Step 2.7: Add `await` at `notifyRunComplete` call site**

```typescript
await this.#finalizeRun(spanId, attemptSeq, status);  // was: this.#finalizeRun(...)
```

- [ ] **Step 2.8: Run typecheck + test**

```bash
cd apps/backend && bun run typecheck && bun test --test-name-pattern="SpanSupervisor|RunSupervisor|executeAgentRun"
```
Expected: PASS

- [ ] **Step 2.9: Commit**

```bash
git commit -m "refactor(backend): convert supervisor.ts raw SQL to drizzle ORM"
```

---

### Task 3: service.ts — 删 `db` 参数，走 opsStore

**Files:**
- Modify: `apps/backend/src/features/runtime-ops/service.ts`
- Modify: `apps/backend/src/main.ts` (update call site)

- [ ] **Step 3.1: Replace `db.query("SELECT status FROM run WHERE span_id = ?")` with opsStore**

In `getRunDetail` and the cancel/recover methods that query run status:
```typescript
// Before:
const run = db.query("SELECT status FROM run WHERE span_id = ?").get(spanId);
// After:
const run = opsStore.getRunBySpanId(spanId);
```

- [ ] **Step 3.2: Replace `listRuns` raw SQL execution**

The `buildRunQuery` helper returns `{ sql, args }` which is passed to `db.query(sql).all(...args)`. This is the dynamic filter SQL — the one case we keep raw. Wrap it through `opsStore`:

```typescript
// Add to RuntimeOpsStore:
queryRunRaw(sql: string, args: unknown[]): Array<{...}> {
  return this.#db.query(sql).all(...args);
}
```

Or better: expose the raw db from opsStore:
```typescript
getRawDb(): Database { return this.#db; }
```

Then in service.ts, replace `db.query(sql).all(...args)` with `opsStore.getRawDb().query(sql).all(...args)`.

- [ ] **Step 3.3: Remove `db` from `createRuntimeOpsService` deps**

Delete `db: Database` from the parameter type and destructuring. Delete any remaining `db.` references.

- [ ] **Step 3.4: Update main.ts call site**

```typescript
// Before:
const opsSvc = createRuntimeOpsService({ db, opsStore, ... });
// After:
const opsSvc = createRuntimeOpsService({ opsStore, ... });
```

- [ ] **Step 3.5: Run typecheck + test**

```bash
cd apps/backend && bun run typecheck && bun test
```
Expected: PASS

- [ ] **Step 3.6: Commit**

```bash
git commit -m "refactor(backend): remove db parameter from createRuntimeOpsService, use opsStore"
```

---

### Task 4: conv-svc-factory.ts — 删 `_opsStore` + 原始 SQL

**Files:**
- Modify: `apps/backend/src/features/conversation/conv-svc-factory.ts`
- Modify: `apps/backend/src/main.ts` (update call site)

- [ ] **Step 4.1: Replace `verifyRunOwnsConversation` raw SQL**

```typescript
// Before:
const row = runDb.query("SELECT session_id FROM run WHERE span_id = ?").get(spanId);
// After:
const sessionId = opsStore.getSessionIdBySpanId(spanId);
if (!sessionId || !sessionId.startsWith(`${conversationId}:`)) throw ...;
```

- [ ] **Step 4.2: Remove `_opsStore` parameter**

Delete from function signature. Inside the `startAgentRun` callback, `opsStore` is already available from the outer closure or can be accessed via `new RuntimeOpsStore(db)`.

- [ ] **Step 4.3: Update main.ts call site**

```typescript
// Before:
const conv = createConversationFeature(db, config, supervisor, agentSvc, opsStore, ...);
// After:
const conv = createConversationFeature(db, config, supervisor, agentSvc, ...);
```

- [ ] **Step 4.4: Run typecheck + test**

- [ ] **Step 4.5: Commit**

```bash
git commit -m "refactor(backend): remove _opsStore from createConversationFeature, use opsStore method for verifyRunOwnsConversation"
```

---

### Task 5: agent-svc-factory.ts — `purgeEventsForSessions` → drizzle

**Files:**
- Modify: `apps/backend/src/features/agent/agent-svc-factory.ts`

- [ ] **Step 5.1: Convert DELETE + subquery to drizzle**

```typescript
// Before:
edb.run("DELETE FROM attempt WHERE span_id IN (SELECT span_id FROM run WHERE session_id = ?)", [tid]);
edb.run("DELETE FROM run WHERE session_id = ?", [tid]);

// After:
const d = supervisor.getDrizzle();
d.transaction(async (tx) => {
  for (const tid of ids) {
    tx.delete(schema.attempt)
      .where(inArray(schema.attempt.spanId,
        tx.select({ spanId: schema.run.spanId }).from(schema.run).where(eq(schema.run.sessionId, tid))
      )).run();
    tx.delete(schema.run).where(eq(schema.run.sessionId, tid)).run();
  }
});
```

- [ ] **Step 5.2: Run typecheck + test**

- [ ] **Step 5.3: Commit**

```bash
git commit -m "refactor(backend): convert agent-svc purgeEventsForSessions to drizzle ORM"
```

---

### Task 6: 删 `createRunQueryService` 死代码

**Files:**
- Modify: `apps/backend/src/features/runtime-ops/span-query-service.ts`

- [ ] **Step 6.1: Delete the function, keep `buildRunQuery`**

`createRunQueryService` is never called — only `buildRunQuery` is imported from this file.

- [ ] **Step 6.2: Run typecheck + test**

- [ ] **Step 6.3: Commit**

```bash
git commit -m "refactor(backend): delete dead createRunQueryService function"
```

---

### Task 7: 最终验证

- [ ] **Step 7.1: Verify no remaining raw SQL on run/attempt tables (outside adapters)**

```bash
grep -rn "FROM run\|FROM attempt\|UPDATE run\|UPDATE attempt\|INSERT INTO run\|INSERT INTO attempt" --include="*.ts" src/ | grep -v "test\|adapter-sqlite\|node_modules"
```
Expected: only adapter-sqlite files and comments.

- [ ] **Step 7.2: Run full lint, typecheck, test**

```bash
cd /root/my-agent-team && bun run lint && bun run typecheck && cd apps/backend && bun test
```

- [ ] **Step 7.3: Push**
