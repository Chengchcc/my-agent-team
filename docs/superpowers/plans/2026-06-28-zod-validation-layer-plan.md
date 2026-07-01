# 类型归一化 — 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 对全部 15 张表建立 `drizzle schema → drizzle-zod → z.infer → TS type` 单向类型推导链，消除 3+ 处手写类型漂移，统一 HTTP body Zod 校验，对齐前端类型。

**Architecture:** 6 Phase，自底向上：安装 → 生成 schema → store → service → HTTP → 前端对齐。

**Tech Stack:** TypeScript, drizzle-orm, drizzle-zod, zod

---

### Task 1: 安装 + 15 表 Schema 生成

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `apps/backend/src/infra/db/schema.ts`

- [ ] **Step 1.1: 安装**

```bash
cd apps/backend && bun add drizzle-zod
```

- [ ] **Step 1.2: schema.ts 末尾追加所有表的 Zod schema**

```typescript
import { createSelectSchema, createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// 辅助
const jsonField = <T>(fallback: T) =>
  z.string().transform((s) => { try { return JSON.parse(s) as T; } catch { return fallback; } });
const intBool = z.number().transform((n) => n !== 0);

// 15 表各导出 SelectSchema + InsertSchema
export const runSelectSchema = createSelectSchema(run);
export const runInsertSchema = createInsertSchema(run);

export const attemptSelectSchema = createSelectSchema(attempt);
// ...

export const controlPlaneEventSelectSchema = createSelectSchema(controlPlaneEvent, {
  payload: jsonField<Record<string, unknown>>({}),
});
// ...

export const runOriginSelectSchema = createSelectSchema(runOrigin);
// ...

export const surfaceHealthSelectSchema = createSelectSchema(surfaceHealth, {
  payload: jsonField<Record<string, unknown>>({}),
});
// ...

export const issueSelectSchema = createSelectSchema(issue);
export const issueInsertSchema = createInsertSchema(issue);

export const projectSelectSchema = createSelectSchema(project, {
  autoOrchestrate: intBool,
});
// ...

export const cronJobSelectSchema = createSelectSchema(cronJob, {
  enabled: intBool,
});
// ...

export const agentsSelectSchema = createSelectSchema(agents);
// ...

export const issueEventSelectSchema = createSelectSchema(issueEvent, {
  payload: jsonField<Record<string, unknown>>({}),
});
// ...

// conversation/member/ledger: 已有共享包，不需要
```

- [ ] **Step 1.3: typecheck**

```bash
cd apps/backend && bun run typecheck
```

- [ ] **Step 1.4: Commit**

---

### Task 2: store.ts + types.ts → Zod 推断

**Files:**
- Modify: `apps/backend/src/features/runtime-ops/store.ts`
- Modify: `apps/backend/src/features/runtime-ops/types.ts`
- Modify: `apps/backend/src/features/runtime-ops/index.ts`

- [ ] **Step 2.1: 删 3 个手动 mapper，用 Zod `.parse()`**

```typescript
// Before: toControlPlaneEventRecord(r) — 手写字段映射 + JSON.parse
// After:
import { controlPlaneEventSelectSchema } from "../../infra/db/schema.js";
// getControlPlaneEvents: .all().map((r) => controlPlaneEventSelectSchema.parse(r))
```

`toSpanOriginRow` 和 `toSurfaceHealthRow` 同理。

- [ ] **Step 2.2: types.ts → `z.infer<>`**

```typescript
// Before: export interface ControlPlaneEvent { seq: number; ... }
// After:
import { controlPlaneEventSelectSchema } from "../../infra/db/schema.js";
export type ControlPlaneEvent = z.infer<typeof controlPlaneEventSelectSchema>;
export type ControlPlaneEventKind = ControlPlaneEvent["kind"];
```

`SpanOriginRow`, `SurfaceHealthRow` 同理。

- [ ] **Step 2.3: index.ts 重导出类型不变**（对外接口保持）

- [ ] **Step 2.4: typecheck + test**

- [ ] **Step 2.5: Commit**

---

### Task 3: service.ts DTO → Zod 推断 + 消除内联重复

**Files:**
- Modify: `apps/backend/src/features/runtime-ops/service.ts`

- [ ] **Step 3.1: `ops: Array<{...}>` → 引用 `ControlPlaneEvent`**

```typescript
// Before: ops: Array<{ seq: number; kind: string; payload: Record<string, unknown>; traceId: string | null; ts: number }>
// After:
import type { ControlPlaneEvent } from "./types.js";
// ops: Pick<ControlPlaneEvent, "seq" | "kind" | "payload" | "traceId" | "ts">[]
```

- [ ] **Step 3.2: `RunOpsListItem` → Partial Zod推断 + 计算字段**

```typescript
type RunRow = z.infer<typeof runSelectSchema>;
export interface RunOpsListItem extends Pick<RunRow, "spanId" | "sessionId" | "agentId" | "kind" | "parentSpanId" | "status" | "startedAt" | "endedAt"> {
  agentName: string;
  traceId: string | null;
  latestAttemptSeq: number | null;
  lastEventType: string | null;
  lastOpsEventKind: string | null;
}
```

- [ ] **Step 3.3: `RunOpsDetail.run` 同理**

- [ ] **Step 3.4: `getSessionDetail` 返回 + `listSessions` 返回** → Zod 推断

- [ ] **Step 3.5: typecheck + test**

- [ ] **Step 3.6: Commit**

---

### Task 4: HTTP body 校验 Zod 化

**Files:**
- Modify: `apps/backend/src/features/runtime-ops/http.ts`
- Modify: `apps/backend/src/features/issue/http.ts`（按需）
- Modify: `apps/backend/src/features/conversation/http.ts`（按需）

- [ ] **Step 4.1: `larkHeartbeat` → `surfaceHealthInsertSchema.safeParse()`**

- [ ] **Step 4.2: 其他 handler 按需替换**

- [ ] **Step 4.3: typecheck + test**

- [ ] **Step 4.4: Commit**

---

### Task 5: 前端类型对齐

**Files:**
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 5.1: `RunOpsListItem` / `RunOpsDetail` 修复漂移**

```typescript
// runId → spanId, parentRunId → parentSpanId
// 删 heartbeatAgeMs, runnerTransport, transport, heartbeatAt
```

- [ ] **Step 5.2: `ProjectRow.autoOrchestrate` boolean → number**

或后端加 transform 传 boolean。

- [ ] **Step 5.3: `ColumnConfigRow` 补 `approvalPosture`**

- [ ] **Step 5.4: `CronJobRow.enabled` boolean → number**

- [ ] **Step 5.5: Frontend typecheck**

```bash
cd apps/web && bun run typecheck
```

- [ ] **Step 5.6: Commit**

---

### Task 6: adapter 层对齐

**Files:**
- Modify: `apps/backend/src/features/agent/adapter-sqlite.ts`
- Modify: `apps/backend/src/features/issue/adapter-sqlite.ts`
- 等 `*-adapter-sqlite.ts`

- [ ] **Step 6.1: 返回类型从 `$inferSelect` 推导**

```typescript
import { issueSelectSchema } from "../../infra/db/schema.js";
type IssueRow = z.infer<typeof issueSelectSchema>;
```

- [ ] **Step 6.2: typecheck + test**

- [ ] **Step 6.3: Commit**

---

### Task 7: 最终验证

- [ ] **Step 7.1: Full typecheck**

```bash
cd /root/my-agent-team && bun run typecheck
```

- [ ] **Step 7.2: Full test**

```bash
cd apps/backend && bun test
```

- [ ] **Step 7.3: Frontend test**

```bash
cd apps/web && bun run typecheck
```

- [ ] **Step 7.4: Lint**

```bash
cd /root/my-agent-team && bun run lint
```

- [ ] **Step 7.5: Push**
