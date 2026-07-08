# Spec: Settings 模块 - 统一配置管理中心

> 状态：待评审
> 关联：ADR 0011（Web IA Work/Chat/Team）
> 设计约束：`docs/architecture/design-philosophy.md` -- 暴露业务、隐藏机制

## 1. 目标

把 backend/harness 中散落在环境变量、硬编码默认值里的配置项，统一收敛到 Settings 模块。后端是通用 KV store，前端按领域分 section 组织表单。

## 2. 配置分类

### 2.1 环境变量（只读，部署配置）

进程启动时读取，改了需要重启。这些是部署配置--告诉进程"你在哪里运行、连什么服务"。

| 配置项 | 来源 | 说明 |
|--------|------|------|
| `BACKEND_AUTH_TOKEN` | env.ts | 脱敏显示 |
| `BACKEND_HOST` / `BACKEND_PORT` | env.ts | 服务地址 |
| `BACKEND_DATA_DIR` | env.ts | 数据根目录 |
| `BACKEND_WORKSPACE_ROOT` | config.ts | Agent 工作空间根 |
| `BACKEND_TEMPLATE_DIR` | config.ts | Agent 模板目录 |
| `ANTHROPIC_API_KEY` | env.ts | 脱敏显示 |
| `ANTHROPIC_BASE_URL` | env.ts | LLM 网关地址 |
| `NODE_ENV` / `RUNNER_ENV` | env.ts | 运行环境 |
| `dataDir/agents/` | 派生 | Agent 工作空间路径 |
| `dataDir/skill-packs/` | 派生 | Skill Pack 安装路径 |
| `dataDir/checkpointer.db` | 派生 | Checkpointer DB 路径 |
| `dataDir/backend.db` | 派生 | 主 DB 路径 |
| `builtinSkillsDir` | config.ts | 内置 skills 目录 |

### 2.2 运行时参数（可编辑，行为调优）

进程运行期间可动态调整，改了对新请求立即生效。当前硬编码在代码里，改为存 DB KV store。

**KV store 设计**：key 命名规范 `domain.fieldName`。后端不预定义 key 列表--存什么由各 feature 自行决定。新增参数只需在消费处加一行 `settings.get('domain.field') ?? defaultValue`。

#### Agent Session 领域（`agent.*`）

| key | 默认值 | 类型 | 说明 |
|-----|--------|------|------|
| `agent.maxSteps` | 50 | number | 单次 run 最大步数 |
| `agent.retryMaxAttempts` | 3 | number | 重试最大次数 |
| `agent.retryBackoffMs` | 2000 | number | 重试初始退避 |
| `agent.retryMaxBackoffMs` | 30000 | number | 重试最大退避 |
| `agent.compactionAutoCompact` | true | boolean | 自动压缩开关 |
| `agent.compactionKeepRecent` | 10 | number | 压缩保留最近消息数 |

#### Conversation 领域（`conversation.*`）

| key | 默认值 | 类型 | 说明 |
|-----|--------|------|------|
| `conversation.maxHops` | 8 | number | Agent->Agent 连续触发上限 |

#### Context Manager 领域（`context.*`）

| key | 默认值 | 类型 | 说明 |
|-----|--------|------|------|
| `context.toolResultMaxChars` | 50000 | number | Tool 结果截断长度 |
| `context.summarizeTriggerAt` | 100000 | number | 自动摘要触发 token 数 |
| `context.summarizeKeepRecent` | 10 | number | 摘要保留最近消息数 |

#### Runtime 领域（`runtime.*`，需重启生效）

| key | 默认值 | 类型 | 说明 |
|-----|--------|------|------|
| `runtime.heartbeatIntervalMs` | 5000 | number | 心跳间隔 |
| `runtime.heartbeatTimeoutMs` | 120000 | number | 心跳超时 |
| `runtime.cancelGraceMs` | 5000 | number | 取消宽限期 |
| `runtime.reaperIntervalMs` | 60000 | number | Reaper 扫描间隔 |
| `runtime.stepStallTimeoutMs` | 300000 | number | 步骤卡死超时 |
| `runtime.maxConcurrentRuns` | 10 | number | 最大并发 run 数 |

#### Loop Defaults 领域（`loop.*`）

| key | 默认值 | 类型 | 说明 |
|-----|--------|------|------|
| `loop.generatorModel` | claude-sonnet-4 | string | Generator 默认模型 |
| `loop.evaluatorModel` | claude-opus-4 | string | Evaluator 默认模型 |
| `loop.defaultAcceptance` | 被修改的文件相关测试全绿，改动范围合理 | string | 默认验收标准 |
| `loop.defaultDailyCap` | 200000 | number | 默认每日 token 上限 |
| `loop.defaultDenylist` | [".env","auth/","payments/","secrets/"] | string[] | 默认禁改路径 |

### 2.3 扩展约定

其他 feature 要使用 settings 模块时：
1. 选定 key 前缀（如 `featureName.fieldName`）
2. 在消费处调 `settings.get<T>('featureName.fieldName') ?? defaultValue`
3. 前端在对应领域 section 加一行表单项
4. 不需要改 schema、不需要 migration、不需要改 settings service 接口

## 3. 后端设计

### 3.1 新增 `settings` feature

```
apps/backend/src/features/settings/
├── domain.ts          # SettingsRow 接口
├── ports.ts           # SettingsPort（key-value 读写）
├── adapter-sqlite.ts  # SQLite 实现（settings 表 key/value/updatedAt）
├── service.ts         # createSettingsService（get/set/getAll/getSystemInfo）
├── http.ts            # GET/PUT /api/settings + GET /api/settings/system
└── index.ts           # barrel
```

### 3.2 DB schema

```typescript
export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),  // JSON string
  updatedAt: integer({ mode: "number" }).notNull(),
});
```

### 3.3 API

```
GET /api/settings           -> { settings: Record<string, unknown> }
PUT /api/settings/:key      -> body: { value: unknown } -> { ok: true, key, value }
GET /api/settings/system    -> { env: {...}, paths: {...} }  (只读)
```

### 3.4 Settings service 接口

```typescript
interface SettingsService {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  getAll(): Record<string, unknown>;
  getSystemInfo(): { env: Record<string, string>; paths: Record<string, string> };
}
```

### 3.5 配置消费

各 feature 在消费处改为从 settings 读取：
```typescript
// conversation-compose.ts
const maxHops = settings.get<number>('conversation.maxHops') ?? 8;

// agent-helpers.ts
const maxChars = settings.get<number>('context.toolResultMaxChars') ?? 50000;

// agent-session.ts 默认值
const maxSteps = settings.get<number>('agent.maxSteps') ?? 50;
```

Settings service 在 main.ts 创建，注入到各 feature。

### 3.6 System 信息端点

`GET /api/settings/system` 返回当前环境变量和路径配置（只读，脱敏）：
```typescript
{
  env: {
    BACKEND_HOST: "0.0.0.0",
    BACKEND_PORT: 3000,
    ANTHROPIC_API_KEY: "****key1",  // 脱敏
  },
  paths: {
    dataDir: "/data",
    workspaceRoot: "/data/workspaces",
    agentWorkspace: "/data/agents/:id",
    skillPacks: "/data/skill-packs",
    checkpointerDb: "/data/checkpointer.db",
    backendDb: "/data/backend.db",
    builtinSkills: "/skills",
  }
}
```

## 4. 前端设计

### 4.1 路由

`/system/settings` - 归在 System 组下。

### 4.2 页面布局

按领域分 section 的滚动表单（不是 tab）：

```
┌─────────────────────────────────────────┐
│  Settings                               │
│                                         │
│  ┌─ Agent Session ────────────────────┐ │
│  │  Max Steps:        [50      ]      │ │
│  │  Retry Attempts:   [3       ]      │ │
│  │  Retry Backoff:    [2000    ] ms   │ │
│  │  Retry Max Backoff:[30000   ] ms   │ │
│  │  Auto Compact:     [✓]              │ │
│  │  Keep Recent:      [10      ]      │ │
│  │  [Save]                             │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ┌─ Conversation ─────────────────────┐ │
│  │  Max Hops:         [8       ]      │ │
│  │  [Save]                             │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ┌─ Context Manager ──────────────────┐ │
│  │  Tool Result Max:  [50000   ] chars│ │
│  │  Summarize At:     [100000  ] tok  │ │
│  │  Keep Recent:      [10      ]      │ │
│  │  [Save]                             │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ┌─ Runtime ⚠️ 需重启生效 ─────────────┐ │
│  │  Heartbeat Interval: [5000  ] ms   │ │
│  │  Heartbeat Timeout:  [120000] ms   │ │
│  │  ...                               │ │
│  │  [Save]                             │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ┌─ Loop Defaults ────────────────────┐ │
│  │  Generator Model: [claude-sonnet-4]│ │
│  │  Evaluator Model: [claude-opus-4  ]│ │
│  │  Default Acceptance: [           ] │ │
│  │  Daily Cap:       [200000  ]       │ │
│  │  Denylist:        [.env, auth/...] │ │
│  │  [Save]                             │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ┌─ System Info (只读) ───────────────┐ │
│  │  Backend Host: 0.0.0.0              │ │
│  │  Backend Port: 3000                 │ │
│  │  Data Dir: /data                    │ │
│  │  API Key: ****key1                  │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

每个 section 有独立 Save 按钮。Runtime section 有"需重启生效"badge。System Info section 无 Save（只读）。

### 4.3 NavRail

System 组加 "Settings" 入口 -> `/system/settings`。

### 4.4 前端 hooks

```typescript
// features/settings/hooks.ts
export function useSettings() { ... }       // GET /api/settings
export function useUpdateSetting() { ... }  // PUT /api/settings/:key
export function useSystemInfo() { ... }     // GET /api/settings/system
```

### 4.5 前端扩展约定

新增 settings 参数时：
1. 后端 feature 调 `settings.get('domain.field') ?? default`
2. 前端在对应 domain section 加一行表单项
3. 不需要改 hooks 或 API--`useSettings` 返回全部 KV，前端按 key 取值

## 5. 验收标准

1. `GET /api/settings` 返回所有 KV
2. `PUT /api/settings/:key` 修改并持久化
3. `GET /api/settings/system` 返回环境变量和路径（脱敏）
4. `/system/settings` 按领域分 section 展示
5. 每个 section 有独立 Save
6. Runtime section 有"需重启生效"badge
7. System Info section 只读
8. NavRail System 组有 Settings 入口
9. 修改运行时参数后，新 session 使用新值
10. typecheck + test + lint 全绿

## 6. 不做的事

- 不做环境变量的在线修改（需重启）
- 不做 per-agent 参数覆盖
- 不做 settings 变更历史
- 不做 settings 导入/导出
