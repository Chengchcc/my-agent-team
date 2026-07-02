# M4 Spec — CronJob 集成 + fireLoop() 调度

> **Status:** 🏗 Design → Implementation
> **Baseline:** M3（AgentSession 接线）完成态。
> **关联:** `apps/backend/src/features/cron/` · `apps/backend/src/features/loop/loop-step.ts` · `apps/backend/src/infra/db/schema.ts`

**Goal:** CronJob 表加 `loop_config_path` 列，scheduler 的 `fire()` 分支到 `fireLoop()`——Loop 首次被定时调度触发，跑完整条 discovery→generator→evaluator 链。

**Non-goals:**
- 不加 loop 粒度写锁（MVP 只有 cron 一条入口，inFlight 够用）
- 不加原子预算计数（M5 随 LOOP.md 落地）
- 不加 AgentSession 并发池（MVP 串行一个 item）
- 不做前端 Loop dashboard（M5）
- 不做手动触发/HTTP review API（M5）

---

## 1. 架构变更

```
cron_job 表:
  + loop_config_path TEXT  (NULL → 老 CronJob; 有值 → Loop)

scheduler.fire():
  原有 → executeAgentRun(...)（不变）
  新分支 → fireLoop(...)（loop 专用）
```

## 2. 数据变更

### cron_job 表

```sql
ALTER TABLE cron_job ADD COLUMN loop_config_path TEXT;
```

drizzle schema:

```typescript
// apps/backend/src/infra/db/schema.ts
export const cronJob = sqliteTable("cron_job", {
  // ... 现有列
  loopConfigPath: text("loop_config_path"),  // M4 新增
});
```

### CronJobRow

```typescript
export interface CronJobRow {
  // ... 现有字段
  loopConfigPath?: string;  // M4 新增
}
```

### `kind` 过滤

`GET /api/cron-jobs?kind=loop` → `WHERE loop_config_path IS NOT NULL`
`GET /api/cron-jobs?kind=cron` → `WHERE loop_config_path IS NULL`
`GET /api/cron-jobs` → 全部（向后兼容）

## 3. Scheduler 变更

### register() — 跳过 manual loop

```typescript
register(job: CronJobRow) {
  // manual loop: no schedule, no Bun.cron
  if (!job.enabled || !job.cronExpr) return;
  // ... 现有注册逻辑
}
```

### fire() — 加分支

```typescript
async function fire(job: CronJobRow, _fireKey?: string) {
  if (job.loopConfigPath) {
    return fireLoop(job);
  }
  // 原有逻辑不变
  // ... executeAgentRun + watchdog
}
```

### fireLoop() — loop 专用

```typescript
async function fireLoop(job: CronJobRow) {
  let attempt = 0;
  let currentJob = job;

  while (true) {
    try {
      const result = job.timeoutMs > 0
        ? await withTimeout(
            loopStep({
              loopConfigPath: currentJob.loopConfigPath!,
              sessionFactory: deps.sessionFactory!,
              buildSpec,
            }),
            currentJob.timeoutMs,
          )
        : await loopStep({
            loopConfigPath: currentJob.loopConfigPath!,
            sessionFactory: deps.sessionFactory!,
            buildSpec,
          });
      return result;
    } catch (err) {
      attempt++;
      if (attempt > (currentJob.maxRetries ?? 0)) throw err;

      // 退避前重读——人可能在重试期间改了 job
      const fresh = deps.cronSvc.port.getCronJob(job.cronJobId);
      if (!fresh) throw err;
      currentJob = fresh;

      await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000));
    }
  }
}
```

### buildSpec 工厂

```typescript
// 放到 scheduler.ts 内或 import 自 loop feature
function buildSpec(params: { sessionId: string; modelName: string; cwd: string }): SessionSpec {
  return {
    agentId: LOOP_AGENT_ID,
    cwd: params.cwd,
    model: makeModel({ modelName: params.modelName, modelProvider: "anthropic", modelBaseUrl: null }),
    modelName: params.modelName,
    plugins: [/* fs-memory, progressive-skill, ... */],
    tools: [/* bash, edit, grep, ... */],
    checkpointer: sqliteCheckpointer(...),
    contextManager: pipeContextManagers(...),
  };
}
```

> M5 落地 LOOP.md 后，modelName 从 LOOP.md 读，不再硬编码。

## 4. HTTP API

```typescript
GET /api/cron-jobs?kind=loop
  → cronSvc.list().filter(j => j.loopConfigPath != null)

GET /api/cron-jobs?kind=cron
  → cronSvc.list().filter(j => j.loopConfigPath == null)
```

不改现有路由签名，只加 query 参数。

## 5. 验收标准

1. **DB migration**：`cron_job` 表有 `loop_config_path TEXT` 列，老行该列为 NULL
2. **`kind=loop` 过滤**：`GET /api/cron-jobs?kind=loop` 只返回 loopConfigPath 非 NULL 的行
3. **`kind=cron` 过滤**：只返回 loopConfigPath IS NULL 的行
4. **无 kind 参数**：返回全部（向后兼容）
5. **manual loop 不注册 Bun.cron**：`cronExpr=NULL` 的 job 在 `register()` 时跳过
6. **fire() 分支**：`loopConfigPath` 有值 → 走 `fireLoop()`；NULL → 走老路 `executeAgentRun`
7. **fireLoop() 调用 loopStep()**：scheduler 触发时 loopStep 被调用，参数正确
8. **fireLoop() retry**：loopStep 抛异常 → 退避重试，不超 maxRetries
9. **fireLoop() timeout**：timeoutMs > 0 → loopStep 超时被 cancel，触发 retry
10. **fireLoop() 重试前重读 job**：retry 循环内从 port 读到最新 job 数据
11. **inFlight 锁不变**：fire() 开头拿锁，fireLoop() 成功/最终失败释放锁
12. **老 CronJob 不受影响**：loopConfigPath=NULL 的 job 走原有全链路
13. **全 workspace typecheck + lint + test 通过**

## 6. 实施分组

| Patch | 内容 | 文件 |
|---|---|---|
| P1 | drizzle schema + migration: `loop_config_path TEXT` | `schema.ts`, migration |
| P2 | CronJobRow + adapter + service: 加可选字段 | `domain.ts`, `adapter-sqlite.ts`, `service.ts` |
| P3 | HTTP: `kind` query 参数 | `http.ts` |
| P4 | Scheduler: `fire()` 分支 + `fireLoop()` + `register()` 跳过 manual | `scheduler.ts` |
| P5 | Scheduler test: fireLoop retry/timeout/重读 | `scheduler.test.ts` |
| P6 | 全 workspace 验证 | — |

## 7. 风险

1. **`fireLoop()` 与现有 `fire()` 共用 `inFlight` 锁**：两路径共享同一把锁没有问题——同一 Job 同时只有一个 fire 在飞。
2. **`buildSpec` 硬编码插件/工具**：M5 落地 LOOP.md 后从配置读。M4 仅证明"cron 能触发 loopStep"。
3. **fireLoop() 里调 `loopStep` 是 awaitable**：Bun.cron handler 会等它跑完才返回。Bun.cron 不重叠保证确保下一次触发在这之后。
