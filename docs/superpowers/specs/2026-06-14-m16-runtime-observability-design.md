# M16 — Runtime Observability 设计文档

> 日期：2026-06-14
> 基线：`fb8d40e`（next，已含 resident runner、run/attempt 表、heartbeat reaper、Lark card streaming）
> 关联 spec：用户提供的 M16 详细规格（16 节，含 SQL schemas、API contracts、commit 序列）

## 一、目标

补一层**运行时观测与控制面**：用 OpenTelemetry 作为跨 backend / runner / surface 的观测协议，用 RuntimeOps 表保存可恢复的本地事实，用 Web 观测面把 trace、run、attempt、surface projection 串起来。

## 二、已有基础 vs 需新建

### 已存在（直接可用）

| 能力 | 位置 |
|------|------|
| Run/Attempt 表 + heartbeat + reaper | `apps/backend/src/features/run/` |
| EventLog (append-only, subscribable) | `packages/event-log/` |
| RunnerRegistry (Dev/Prod) + transportFor | `apps/backend/src/features/run/runner-registry.ts` |
| Transport 协议 (start/abort/run_finalized + event/delta/heartbeat/run_done) | `packages/runner-protocol/` |
| Lark bindings SQLite (含 run_stream) | `apps/lark-bot/src/bindings-sqlite.ts` |
| Web Next.js 15 + shadcn/ui + Tailwind | `apps/web/` |

### 需新建

| M16 Part | 内容 |
|----------|------|
| A — Observability Spine | `packages/runtime-observability/` 整个包 |
| B — Run Diagnostics | `run_ops_event` / `run_origin` / `runner_health` / `surface_health` 四张表 + RuntimeOpsStore |
| C — Recovery & Control | `RunnerRegistry.attachExisting()` / `healthOf()`；ops API 路由 |
| D — Runner Health | `daemon_health` 协议消息；daemon idle 时也发送 |
| E — Surface Diagnostics | Lark bot HTTP client 向 backend 上报脱敏 heartbeat |
| F — Ops Console | Web `/ops` 路由 + 全套组件 |

## 三、新增 package

```
packages/runtime-observability/
  src/index.ts          # Re-exports RuntimeTracer, RuntimeMetricSink, types
  src/config.ts         # ObservabilityConfig, resolveMode (off/console/otlp)
  src/tracer.ts         # RuntimeTracer impl (console + otlp backends)
  src/metrics.ts        # RuntimeMetricSink impl
  src/redaction.ts      # Redaction rules
  src/types.ts          # RuntimeSpanName, RuntimeSpanAttributes, RuntimeMetricSpec
  src/*.test.ts
```

## 四、数据迁移（4 张新表，events.db）

```sql
-- Migration 3006
CREATE TABLE run_ops_event (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  attempt_id   TEXT,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  trace_id     TEXT,
  ts           INTEGER NOT NULL
);

-- Migration 3007
CREATE TABLE run_origin (
  run_id            TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  source_ledger_seq INTEGER NOT NULL,
  agent_member_id   TEXT NOT NULL,
  surface           TEXT NOT NULL DEFAULT 'web',
  trace_id          TEXT NOT NULL,
  traceparent       TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

-- Migration 3008
CREATE TABLE runner_health (
  agent_id          TEXT PRIMARY KEY,
  last_seen_at      INTEGER,
  uptime_ms         INTEGER,
  active_run_count  INTEGER NOT NULL DEFAULT 0,
  active_run_ids    TEXT NOT NULL DEFAULT '[]',
  checkpointer_ok   INTEGER NOT NULL DEFAULT 1,
  workspace_ok      INTEGER NOT NULL DEFAULT 1,
  last_error        TEXT,
  updated_at        INTEGER NOT NULL
);

-- Migration 3009
CREATE TABLE surface_health (
  agent_id       TEXT NOT NULL,
  surface        TEXT NOT NULL,
  status         TEXT NOT NULL,
  last_seen_at   INTEGER,
  payload        TEXT NOT NULL,
  last_error     TEXT,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (agent_id, surface)
);
```

不回填历史 run；旧 run 的 trace/ops 为空也合法。

## 五、协议扩展

### HostToRunner 增加 trace

```ts
{ type: "start"; runId: string; spec: Record<string, unknown>; trace?: RuntimeTraceContext }
```

### RunnerToHost 新增 daemon_health

```ts
{ type: "daemon_health"; agentId: string; uptimeMs: number; activeRunIds: string[];
  checkpointer: { kind: "sqlite"; ok: boolean; lastError?: string };
  workspace: { ok: boolean; lastError?: string }; ts: number }
```

## 六、核心接口

### RuntimeTracer（项目内窄接口，不暴露 OTel SDK 类型）

```ts
interface RuntimeTracer {
  startSpan<T>(name: RuntimeSpanName, attrs: RuntimeSpanAttributes, fn: () => Promise<T>): Promise<T>;
  currentTrace(): RuntimeTraceContext | null;
  inject(): RuntimeTraceContext;
  link(trace: RuntimeTraceContext, attrs?: Record<string, unknown>): void;
}
```

### RuntimeOpsSink

```ts
interface RuntimeOpsSink {
  appendRunEvent(input: { runId: string; attemptId?: string; kind: RunOpsEventKind;
    traceId?: string; payload?: Record<string, unknown> }): void;
}
```

## 七、不变量的代码级保障

1. EventLog 仍是 run 事件事实源 — OTel trace 可丢、可采样
2. conversation ledger 仍是用户可见事实源 — ops API 不直接生成聊天消息
3. Checkpointer 不进 backend — runner-local SQLiteCheckpointer 观测面不读取
4. run status 不膨胀 — reattach/orphan/reaper 是 ops event，不改 status 枚举
5. surface 本地绑定不进 backend — Lark chat_id→conversationId 绑定留在 bindings.sqlite
6. 控制动作幂等 — cancel/recover/retry 重复调用返回当前事实
7. trace id 跨层传播 — 同一用户输入→ledger→run→attempt→tool→surface card
8. 观测默认脱敏 — message text/tool input/chat_id/open_id/secret 不进 span attributes

## 八、落地顺序（9 commits）

| # | Commit | 核心产出 | 可独立验证 |
|---|--------|---------|-----------|
| 1 | RuntimeOps store + migrations | 4 张表 + RuntimeOpsStore | CRUD 单测 |
| 2 | OpenTelemetry spine | `packages/runtime-observability`；backend/runner/lark 接入 | redaction/inject/extract 单测 |
| 3 | RunSupervisor instrumentation | start/done/cancel/reaper 写 ops event；span 包裹关键路径 | ops event 写入验证 |
| 4 | Registry attachExisting + rediscover reattach | 非破坏 attach；reattach_succeeded/failed ops event | attach success/fail/stale reap 单测 |
| 5 | daemon_health protocol | 协议加 daemon_health；idle 时也发送；backend upsert runner_health | idle/busy/degraded/offline 状态计算 |
| 6 | ops APIs | GET runs/list/detail；POST cancel/recover/retry；GET traces；GET agent runtime | HTTP 响应格式验证 |
| 7 | run_origin + server-side retry | conversation-triggered run 写 run_origin；retry 从 ledger source seq 重放 | idempotency 防重复 |
| 8 | Lark surface heartbeat | lark-bot 汇总 watcher/run_stream 状态 POST backend；upsert surface_health | 脱敏验证 |
| 9 | Observability Console (Web) | /ops 首页；run detail；trace waterfall；agent runtime；cancel/recover/retry buttons | 页面渲染验证 |

## 九、测试策略

- **Backend**：RuntimeOpsStore CRUD、RunSupervisor ops events、rediscover reattach、recover 状态机、retry idempotency、trace lookup
- **Observability**：trace context 传播、retry trace link、redaction 阻止敏感字段、metrics label 不含高基数 ID、console mode 无外部依赖
- **Protocol/Runner**：daemon_health NDJSON encode/decode、start.trace encode/decode、idle daemon health、unknown message 兼容
- **Lark bot**：heartbeat payload 脱敏、run_stream summary 计数正确、heartbeat failure 不影响 ingest、card failure 不改 run status
- **Web**：run table 渲染、run detail 三条线合一、trace waterfall 本地合成、cancel/recover/retry 按钮刷新

## 十、验收标准

1. `GET /api/ops/runs` 显示 runs、heartbeat age、transport、last event、traceId
2. `GET /api/ops/runs/:id` 解释 run 为什么 terminal 或为什么仍 running
3. backend restart 后优先 reattach；失败显示 reattach_failed
4. cancel 对 terminal run 幂等；对 detached run 返回 detached_waiting_reaper
5. idle runner daemon 显示 idle/online
6. Lark surface 上报脱敏 heartbeat，surface degraded 不改 run status
7. OTel 开启时单次用户输入能看到完整 trace
8. OTel 关闭时 Web 观测面基于本地 DB 合成降级 waterfall
9. metrics 不含 runId/attemptId/traceId 作为 label
10. span/log attributes 不含用户正文、tool input 原文、Lark 私有 ID、secret
11. `/ops` 完成定位闭环：发现问题→打开 run detail→查看 trace→执行 cancel/recover/retry
12. `bun run typecheck` + 所有新增/已有测试通过
