# PR10 — Agent 注册表 + 真实 `setup` / `agent init` + 身份引导 + Lark Bot 管理

**终版 spec**（合并原 spec + Lark 补丁 + 8 轮 grill 决策）

---

## 0. 目标与非目标

### 0.1 目标
1. 把 `profile` 概念从代码库连根拔除，统一为 `agent`
2. 实现真实的 `my-agent agent create` / `my-agent agent init`（替换 `cli-setup.ts`、`cli-agent.ts` stub）
3. 引入 Agent 注册表（SQLite），持久化到 `~/.my-agent/agents.db`
4. Daemon 启动强制要求 `--agent <id>`；`default` 在首次缺失时自动 seed
5. 三种身份（identity）设置路径：M1 问卷式 / M2 LLM 一轮生成 / M3 延后（OpenClaw 风格）
6. Lark Bot 配置作为 agent 的可变属性，支持事后 `lark set/unset/test/enable/disable`
7. 交互体验 = `@clack/prompts` + `chalk`
8. 旧目录旧 env 一次性清理（当前无存量，直接删除旧路径）

### 0.2 非目标
- 不做 agent 编辑 UI
- 不做多用户 / 共享注册表
- 不做 `agent rename`
- 版本历史不持久化（重启丢 history）

---

## 1. 概念模型

> 一个 Agent = 一份身份 + 一组工具/技能 + 一份记忆 + 一份会话历史 + 一个 daemon 实例

| 维度 | 归属 |
|------|------|
| 唯一标识 | `agentId`（slug，正则 `^[a-z][a-z0-9-]{0,31}$`） |
| 身份 | `<agentDir>/identity/identity.md`（+ 可能的 `bootstrap.md`） |
| 记忆 | `<agentDir>/memory/` |
| 会话历史 | `<agentDir>/sessions/` |
| Skills | `<agentDir>/skills/` |
| 进化产物 | `<agentDir>/evolution/` |
| Daemon socket | `<agentDir>/daemon.sock` |
| Lark 绑定 | SQLite `agents.lark_config` 列 |

---

## 2. 命名映射

| 旧 | 新 |
|---|---|
| `profileId` | `agentId` |
| `profileDir` / `profileRoot` | `agentDir` / `agentsRoot` |
| `ProfilePaths` | `AgentPaths` |
| `profile-paths.ts` | `agent-paths.ts` |
| `defaultProfileRoot()` | `defaultAgentsRoot()` |
| `MY_AGENT_PROFILE_ROOT` env | `MY_AGENT_AGENTS_ROOT`（读旧 env 兼容 6 周） |
| `--profile <id>` CLI flag | `--agent <id>`（`--profile` 作为 alias 保留 6 周 + warn） |
| `KernelContext.profileId` / `.profileDir` | `.agentId` / `.agentDir` |
| `ProfileNotFoundError` | `AgentNotFoundError` |
| 表名 / Port 名 | `agents` / `AgentStore` |
| `~/.my-agent/profiles/<id>/` | `~/.my-agent/agents/<id>/` |
| 文档/文案中的 "profile" | "agent" |

Mass rename 执行策略：**路径 C**（`\b` 边界 sed + 手动注释/字符串审查），作为独立 **PR10-0**，内部拆 3 个 commit（0a: 标识符替换, 0b: 文件/目录重命名 + import 路径, 0c: 注释/字符串/文档 + ESLint 防回潮规则）。

---

## 3. 架构分层

| 层 | 新增 / 修改 |
|------|------------|
| `application/ports/` | **新** `agent-store.ts`（完整 CRUD + 语义化 lark 方法）、`agent-registry.ts`（窄接口 `AgentRegistryRead` + `AgentSelfMutator`） |
| `application/contracts/` | **新** `agent-record.ts`（zod codec）、`agent-lark-events.ts`、`identity-events.ts`（增 `identity.mode.changed` / `identity.reloaded`） |
| `application/usecases/` | **新** `create-agent.ts`、`init-identity.ts`、`validate-agent.ts`、`configure-agent-lark.ts`、`init-agent.ts`、`delete-agent.ts` |
| `domain/` | **新** `identity-bootstrap.ts`（状态机 + front-matter + 完成判定）、`identity-doc.ts`（parse/render identity.md）、`identity-startup.ts`（启动一致性校验）、`identity-migration.ts`（6 分支 mode 迁移矩阵） |
| `infrastructure/paths/` | **重命名** `profile-paths.ts → agent-paths.ts`（加 `identity` 嵌套字段、`root→agentDir`、`skills.profile→skills.agent`）、**新** `home-paths.ts`（`HomePaths` 三层拆分）、`migrate-profile-to-agent.ts`（删除旧路径 + 兼容逻辑）、`trash.ts`（trash 路径 + 30d 清理） |
| `infrastructure/agent/` | **新** `sqlite-agent-store.ts`、`sqlite-agent-schema.ts`、`agent-registry-impl.ts` |
| `infrastructure/identity/` | **新** `file-backed-identity-store.ts`（替代 `inmem-identity-store.ts`） |
| `infrastructure/daemon/` | **新** `ping.ts`（`isDaemonAlive` 三步探活） |
| `cli/prompts/` | **新** `prompt-runner.ts`（clack + chalk 适配层） |
| `cli/flows/` | **新** `create-agent-flow.ts`、`identity-flow.ts`、`lark-flow.ts`、`identity-synthesis-prompt.ts`、`manage-lark-flow.ts`、`init-agent-flow.ts`、`delete-agent-flow.ts` |
| `cli/commands/` | **新** `cli-agent-lark.ts`（`lark` 子命令组） |
| `extensions/identity/` | **新** `bootstrap-loop.ts`、`bootstrap-state.ts`；`index.ts` 改为内部状态机（bootstrap 不是独立扩展） |
| `extensions/memory/` | 从 identity 扩展接回 memory recall 职责（SoC 修复）；bootstrap 期跳过 |
| `extensions/frontend.lark/` | 注册 RPC + 订阅事件 + 热加载逻辑 |
| `docs/architecture/` | **新** `kernel-context.md`（KernelContext 只承载启动期不可变快照原则） |

---

## 4. SQLite Schema

文件：`src/infrastructure/agent/sqlite-agent-schema.ts`
运行时位置：`~/.my-agent/agents.db`

```sql
CREATE TABLE IF NOT EXISTS agents (
  agent_id        TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  is_default      INTEGER NOT NULL DEFAULT 0,
  identity_mode   TEXT NOT NULL,
  identity_status TEXT NOT NULL,
  identity_path   TEXT NOT NULL,
  bootstrap_path  TEXT,
  lark_config     TEXT,
  lark_enabled    INTEGER NOT NULL DEFAULT 0,
  lark_last_test_at INTEGER,
  lark_last_test_ok INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_default
  ON agents(is_default) WHERE is_default = 1;
```

迁移在 `migrate(db)` 中幂等执行（`pragma table_info` 检查缺列则 ALTER）。
Pragmas：`WAL` + `synchronous=NORMAL` + `busy_timeout=5000` + `foreign_keys=ON`。
WAL 被 fs 拒绝时 fallback 到 delete journal + logger.warn。

---

## 5. Port 接口

### 5.1 `AgentStore`（`application/ports/agent-store.ts`）

```ts
export interface LarkAgentConfig {
  appId: string
  botId: string
  appSecretEnv: string
  anchorStrategy: 'thread' | 'chat' | 'p2p'
}

export interface AgentRecord {
  agentId: string
  displayName: string
  createdAt: number
  updatedAt: number
  isDefault: boolean
  identityMode: 'questionnaire' | 'llm_oneshot' | 'deferred'
  identityStatus: 'ready' | 'pending_bootstrap'
  identityPath: string
  bootstrapPath: string | null
  larkConfig: LarkAgentConfig | null
  larkEnabled: boolean
  larkLastTestAt: number | null
  larkLastTestOk: boolean | null
}

export interface AgentStore {
  list(): Promise<AgentRecord[]>
  get(agentId: string): Promise<AgentRecord | null>
  exists(agentId: string): Promise<boolean>
  create(rec: AgentRecord): Promise<void>
  update(agentId: string, patch: Partial<AgentRecord>): Promise<void>   // 乐观锁（WHERE updated_at = ?）
  delete(agentId: string): Promise<void>
  getDefault(): Promise<AgentRecord | null>
  setDefault(agentId: string): Promise<void>

  // 语义化 lark 方法
  setLarkConfig(agentId: string, cfg: LarkAgentConfig, opts?: { enable?: boolean }): Promise<void>
  unsetLarkConfig(agentId: string): Promise<void>
  setLarkEnabled(agentId: string, enabled: boolean): Promise<void>
  recordLarkTest(agentId: string, ok: boolean, atMs: number): Promise<void>

  close(): Promise<void>
}
```

### 5.2 窄接口（`application/ports/agent-registry.ts`）

```ts
export interface AgentRegistryRead {
  get(agentId: string): Promise<AgentRecord | null>
  current(): Promise<AgentRecord>                           // 等价于 get(ctx.agentId)
  subscribe(listener: (rec: AgentRecord) => void): () => void
}

export interface AgentSelfMutator {
  recordLarkTest(ok: boolean, at: number): Promise<void>   // 仅能改本 agent
}
```

Kernel 级 provide（`ctx.extensions.provideKernel('agent.registry', ...)` / `'agent.self'`），
在所有扩展 apply 之前注册。扩展层拿不到 `AgentStore` 裸接口。

---

## 6. CLI 交互层

### 6.1 依赖

```jsonc
"dependencies": {
  "@clack/prompts": "^0.x",
  "chalk": "^5.x"
}
```

ESLint `no-restricted-imports`：`chalk` 仅限 `src/cli/**`。

### 6.2 `prompt-runner.ts`

封装：`intro` / `outro` / `text` / `password` / `confirm` / `select` / `multiselect` / `multiline` / `withSpinner` / `cancel` / `assertTTY`。
色彩：`chalk.cyan` 标题、`chalk.gray` 提示、`chalk.red` 错误、`chalk.green` 成功、`chalk.yellow` 警告。

---

## 7. CLI 命令面

```
my-agent agent create               # 交互式创建
my-agent agent list                 # 列出全部，默认行 ★ 标记
my-agent agent show -a <id>         # 详情（lark secret 显示 <env: NAME>）
my-agent agent init -a <id> [--mode] [--reset] [--from-description-file]
my-agent agent default -a <id>      # 设默认
my-agent agent delete -a <id> [--force] [--keep-dir]

my-agent agent lark set     -a <id> [--app-id] [--bot-id] [--secret-env] [--anchor] [--no-test] [--yes]
my-agent agent lark show    -a <id>
my-agent agent lark test    -a <id>
my-agent agent lark unset   -a <id>
my-agent agent lark enable  -a <id>
my-agent agent lark disable -a <id>

my-agent setup                      # = agent create 别名
my-agent daemon start -a <id>       # --agent 必填；省略回退到 default
```

旧 `-p / --profile` 保留 6 周 deprecation 期。

---

## 8. `agent create` 完整流程

```
prompts.intro('my-agent — create new agent')
│
├─ text:    agent_id（slug 校验，默认 slugify(displayName)）
├─ text:    display_name
├─ 检查:    agentDir 已存在但 registry 无记录 → confirm 删除重建
├─ select:  identity_mode [M1 / M2 / M3]
├─ identityFlow(mode)
├─ confirm: 配置 Lark Bot?
│             └─ yes → larkFlow({ smokeCheck: 'ask' })
├─ confirm: 设为默认 agent?
├─ withSpinner('创建中...', async () => {
│      ensureAgentPaths(paths)
│      atomicWrite(paths.identity.file, identityMd)
│      if (bootstrapMd) atomicWrite(paths.identity.bootstrap, bootstrapMd)
│      agentStore.create(record)     ← 最后：registry row 是"agent 就绪"信号
│   })
└─ outro:
     chalk.green('✓ Agent <id> 创建成功')
     chalk.gray('稍后绑定 Lark: my-agent agent lark set -a <id>')
```

---

## 9. 身份（Identity）三模式

模型：**模型 B** — `IdentityStore` 存 `fields: Record<string, string>`（front-matter）+ `body: string`（markdown body），分存。

`transformPrompt` 渲染：

```
<identity>
Role: ${fields.role}
...
</identity>
<identity_full>
${body}
</identity_full>
```

### 9.1 M1 — 问卷式

固定问题，`renderIdentityMd(answers)` 渲染 front-matter + body 模板。`identity_status = 'ready'`。

### 9.2 M2 — LLM 一轮生成

`provider.invoke({ kind: 'internal', purpose: 'identity.synthesize', ... })`。
SYNTHESIS_PROMPT 要求仅输出 markdown，含 front-matter 四字段（role/audience/tone/expertise）。
Defensive：`stripCodeFence` + zod 校验 front-matter 必填字段；缺一则重试，最多 3 次。
非交互：`--from-description-file desc.txt` 跳过 confirm。

### 9.3 M3 — 延后（bootstrap.md）

create 时写占位 `identity.md` + `bootstrap.md`（状态机文件：`status: pending`、`turns_completed: 0`、`turns_max: 6`）。

**Bootstrap Loop**（identity 扩展内部状态机）：
- `transformPrompt`（pre）：if status === 'pending_bootstrap' → 注入 `<bootstrap_request>`；else → 注入 `<identity>`。**两者互斥**。
- `onTurnEnd`（post）：extract → 写 bootstrap.md + 草稿 identity.md → check completion。
- 转场协议：turn N 收集最后一个字段 → onTurnEnd 切 status='ready' → turn N+1 注入完整 identity。
- 失败兜底：provider.invoke 抛错 → logger.warn + 不递增 turns_completed。
- `computeNextAction(state)` → `'ask' | 'finalize' | 'force-finalize'`（满 6 轮强制完成）。

**Memory recall**：从 identity 扩展拆出，归还 memory 扩展（`transformPrompt` normal）。Bootstrap 期 memory 扩展通过 `agent.registry.current()` 读 status 跳过 recall。

### 9.4 启动一致性校验

```
apply() hydration 后:
  agentStore.get(agentId).identityStatus vs identity.md 实际内容:
  - 'ready' 但 identity.md 不存在 → logger.error + 抛错
  - 'pending_bootstrap' 但文件已完整 → 从文件恢复，agentStore.update(status='ready')
  - 一致 → 正常启动
```

---

## 10. `agent init` — 重跑 / 切换身份模式

### 10.1 流程

不带 `--mode` 时交互询问：保留当前 mode 重跑 / 切到新 mode。
Mode 切换矩阵（6 分支）：见下文。

```
1. 计算新内容（newIdentityMd, newBootstrapMd）
2. confirm + diff preview（新旧 fields diff）
3. backup 当前 identity/* → ~/.my-agent/trash/<id>-init-<ts>/
4. atomicWrite(paths.identity.file, newIdentityMd)
5. if M3: atomicWrite(paths.identity.bootstrap, ...) else fs.unlink(bootstrap.md)
6. agentStore.update(...)
7. RPC identity.reload（best-effort；daemon 不在跑则提示下次启动生效）
```

### 10.2 Mode 切换矩阵

| 旧 mode/status | 新 mode | 处理 |
|---|---|---|
| M1 ready | M2 | 旧 fields+body → description prefill |
| M1 ready | M3 | 旧 fields 归档，新建空 bootstrap.md |
| M2 ready | M1 | 旧 fields → 问卷 default；旧 body 弃用 + warn |
| M2 ready | M3 | 同 M1 ready → M3 |
| M3 pending | M1 | collected → 问卷 default，bootstrap.md → bootstrap.aborted.md |
| M3 pending | M2 | collected → description prefill，bootstrap.md → bootstrap.aborted.md |
| M3 pending | M3 | 报错 no-op，需显式 `--reset` |
| M1/M2 ready | 同 mode | 正常重跑，旧内容做 prefill |

纯函数：`prefillForQuestionnaire` / `dehydrateForDescription`（`domain/identity-migration.ts`）。

### 10.3 Identity Reload 协议

RPC `identity.reload`：turn-边界 lock（不在 turn 中间执行）。
- 旧 `pending_bootstrap` → 新 `ready`：bootstrap-loop tear down
- 旧 `ready` → 新 `pending_bootstrap`：bootstrap-loop spin up
- 同状态切换：store.hydrate(新内容)，清版本历史
- 新增 contract 事件 `identity.mode.changed`、`identity.reloaded`

---

## 11. Lark Bot 事后管理

### 11.1 `lark set` CLI 流程

```
1. prompt 收集 → LarkAgentConfig（--non-interactive CI 路径支持）
2. configureAgentLarkUsecase({ kind:'set', ... }) → events
3. agentStore.setLarkConfig(...)           （IO 1：sqlite）
4. bestEffortRpc('agent.lark.reload', {agentId})  （IO 2：通知 daemon）
5. daemon 不在跑 → chalk.gray 提示下次启动生效
6. smoke-check ok → agentStore.recordLarkTest(...)
7. outro
```

### 11.2 `lark unset` / `enable` / `disable` / `test`

- `unset`：清理 lark_config + lark_enabled=0 + 通知 daemon tear down
- `enable/disable`：只切 lark_enabled，不重建 client，只切 listener 状态
- `test`：只读 smoke，不写 store，纯 `LarkClient` token 接口验证
- `show`：打印 appId/botId/secretEnv（仅显示 env 名 + `[✓ env present]`），不打印明文

### 11.3 Lark 扩展运行时改造

- 启动时从 `agent.registry.current()` 读 `lark_config` + `lark_enabled`；disabled 或 null 则不创建 LarkClient
- 注册 RPC：`agent.lark.reload` / `enable` / `disable`
- 订阅 contract bus：`agent.lark.config.set` / `unset` / `enabled.changed` 兜底
- 错误不吞（F7），logger.error + 发 `agent.lark.error` 事件

### 11.4 安全纪律

- `lark show` 永不打印 secret 明文
- `agent.lark.config.set` 事件 payload 不携带配置内容，仅 `agentId`
- RPC `agent.lark.reload` 不传 config，被调端自行从 store 读
- Logger 禁止打印 appSecretEnv 指向的实际 env 值
- `lark test` CI 路径下 secret 走 `--secret-env NAME`，不带字面量

---

## 12. `agent delete` 完整流程

```
my-agent agent delete -a <id> [--force] [--keep-dir]

├─ 1. 校验 agentId 存在
├─ 2. 活跃性检测（除非 --force）
│      isDaemonAlive(socketPath): socket_missing / connect_refused / ping_ok / ping_timeout
│      alive → 拒绝，提示 daemon stop 或 --force
├─ 3. 显示删除清单 + confirm（默认 No）
│      - Lark 绑定 + 目录清单 + 会话数/存储大小
│      - 备份位置：~/.my-agent/trash/<id>-<ts>/
│      - Lark 平台侧 bot 需另行删除
├─ 4. agentStore.delete(agentId)              ← row 先删（事务）
├─ 5. backupToTrash(agentDir, trashRoot)      ← identity.md + bootstrap + DELETE_INFO.json
├─ 6. if (!--keep-dir) fs.rm(agentDir, ...)   ← 失败 warn 不抛
├─ 7. cleanupOldTrash(trashRoot, 30d)         ← best-effort
└─ 8. outro
```

`isDaemonAlive` 三步：socket 存在？→ connect 成功？→ `system.ping` RPC 返回 ok？
`system.ping` RPC 在 controlplane 注册（~10 行）。
默认 agent 允许删除；删完后下次 daemon start 无其他 agent 时重新 seed。

---

## 13. Daemon 启动 Gate

```ts
const agentStore = new SqliteAgentStore(home.registryDb)
await agentStore.init()

let record = await agentStore.get(opts.agentId)
if (!record) {
  if (opts.agentId === 'default') {
    record = await seedDefaultAgent(agentStore, paths)
  } else {
    throw new AgentNotFoundError(...)  // exit code 3
  }
}

// identity_status === 'pending_bootstrap' → logger.info
// agent.registry + agent.self → ctx.extensions.provideKernel(...)
```

`seedDefaultAgent`：M1 渲染"通用编码助手" identity.md，`identity_mode='questionnaire'`、`identity_status='ready'`、`isDefault=true`。

---

## 14. KernelContext 最终形态

```ts
export interface KernelContext {
  // 静态身份（启动期不可变）
  readonly agentId: string
  readonly agentDir: string
  readonly paths: AgentPaths

  // 内核设施（不可变 sink）
  readonly extensions: ExtensionRegistry
  readonly bus: EventBus
  readonly hooks: HookContainer
  readonly rpc: RpcRegistry
  readonly clock: Clock
  readonly logger: Logger
  readonly config: Record<string, unknown>
}
```

**不挂 `agentRecord`**。运行时可变状态（agent record、lark config、identity status）通过 `agent.registry` capability 读。

原则（`docs/architecture/kernel-context.md`）：KernelContext 只承载启动期不可变快照。不要在 KernelContext 上加任何 mutable 字段。

---

## 15. 路径三层拆分

```
HomePaths  — ~/.my-agent/          (homeRoot, agentsRoot, registryDb, trash)
AgentPaths — ~/.my-agent/agents/<id>/ (agentDir, identity{dir,file,bootstrap,archived}, logs, socket, sessions, traces, memory, skills, evolution)
```

`createAgentPaths(agentsRoot, agentId)` 只接收 `agentsRoot` 字符串，不接收 `HomePaths`。`identity` 路径作为嵌套字段暴露，消灭业务代码中的 `path.join` 散落。

---

## 16. Identity Store 最终形态

`FileBackedIdentityStore`（取代 `InMemoryIdentityStore`）：
- `hydrate(snapshot)` — 仅 in-memory，不写盘
- `update(patch, opts)` — 写盘是 update 的语义，自动 `atomicWrite` + 版本递增
- `rollback(version, opts)` — 计算回滚 + 写盘
- `current()` — 返回 `IdentitySnapshot { fields, body, version, updatedAt }`
- `persist()` — 内部，`renderIdentityMd` + `atomicWrite`

`onIdentityChanged` hook 降为通知（纯事件），不做 IO。

---

## 17. Usecase 清单

| Usecase | 输入 | 输出 | 纯/IO |
|---------|------|------|-------|
| `create-agent.ts` | agentId, displayName, identityMode, larkConfig?, isDefault, now | { record, identityPath, bootstrapPath } | 纯 |
| `init-identity.ts` | M1 answers / M2 description+provider / M3 deferred | { identityMd, bootstrapMd } | 纯（M2 注入 ProviderInvoke） |
| `validate-agent.ts` | agentId, displayName | errors[] | 纯 |
| `configure-agent-lark.ts` | kind+config | { events } | 纯 |
| `init-agent.ts` | oldRecord, newMode, opts | { newIdentityMd, newBootstrapMd, backupPaths, events } | 纯 |
| `delete-agent.ts` | agentId, record, paths | { backupPaths } | 纯 |

---

## 18. 事件契约

新增 contract 事件：
- `agent.lark.config.set` / `unset` — payload 仅 `{ agentId }`，不携带 config
- `agent.lark.enabled.changed` — `{ agentId, enabled }`
- `agent.lark.test.recorded` — `{ agentId, ok, at }`
- `identity.mode.changed` — `{ agentId, oldMode, newMode, oldStatus, newStatus }`
- `identity.reloaded` — `{ agentId, reason }`
- `identity.bootstrap.completed` — `{ agentId, turns }`

---

## 19. 文件改动清单

### 新增（~25 文件）
- `src/application/ports/agent-store.ts`
- `src/application/ports/agent-registry.ts`
- `src/application/contracts/agent-record.ts`
- `src/application/contracts/agent-lark-events.ts`
- `src/application/usecases/create-agent.ts`
- `src/application/usecases/init-identity.ts`
- `src/application/usecases/validate-agent.ts`
- `src/application/usecases/configure-agent-lark.ts`
- `src/application/usecases/init-agent.ts`
- `src/application/usecases/delete-agent.ts`
- `src/domain/identity-bootstrap.ts`
- `src/domain/identity-doc.ts`
- `src/domain/identity-startup.ts`
- `src/domain/identity-migration.ts`
- `src/infrastructure/agent/sqlite-agent-store.ts`
- `src/infrastructure/agent/sqlite-agent-schema.ts`
- `src/infrastructure/agent/agent-registry-impl.ts`
- `src/infrastructure/identity/file-backed-identity-store.ts`
- `src/infrastructure/paths/home-paths.ts`
- `src/infrastructure/paths/trash.ts`
- `src/infrastructure/daemon/ping.ts`
- `src/cli/prompts/prompt-runner.ts`
- `src/cli/flows/create-agent-flow.ts`
- `src/cli/flows/identity-flow.ts`
- `src/cli/flows/lark-flow.ts`
- `src/cli/flows/identity-synthesis-prompt.ts`
- `src/cli/flows/manage-lark-flow.ts`
- `src/cli/flows/init-agent-flow.ts`
- `src/cli/flows/delete-agent-flow.ts`
- `src/cli/commands/cli-agent-lark.ts`
- `src/extensions/identity/bootstrap-loop.ts`
- `src/extensions/identity/bootstrap-state.ts`
- `docs/architecture/kernel-context.md`
- `docs/specs/PR10.md`

### 重命名（2）
- `src/infrastructure/paths/profile-paths.ts` → `agent-paths.ts`
- `src/infrastructure/profile/` → `src/infrastructure/agent/`

### 修改（批量 mass rename + 逻辑改动）
- `src/cli/commands/cli-setup.ts` — 退化为 `runCreateAgentFlow()` 调用方
- `src/cli/commands/cli-agent.ts` — 实现 create/list/init/show/default/delete + lark 子命令路由
- `src/cli/cli-runtime.ts` — `buildRuntimeContext` + `disposeRuntimeContext`
- `src/cli/cli-types.ts` — CliRuntimeContext 增加 agentStore
- `src/cli/main.ts` — try/finally 保证 close
- `src/interface/daemon/main.ts` — startup gate + seedDefault + provideKernel
- `src/interface/daemon/parse-daemon-args.ts` — `--agent` 主名 + `--profile` alias
- `src/extensions/identity/index.ts` — FileBackedIdentityStore + bootstrap 内部状态机 + onTurnEnd handler + identity.reload RPC
- `src/extensions/memory/index.ts` — 从 identity 接回 memory recall；bootstrap 期跳过
- `src/extensions/frontend.lark/index.ts` — agent.registry/agent.self capability + RPC 注册 + 事件订阅 + 热加载
- `src/extensions/controlplane/methods.ts` — system.ping RPC
- `src/kernel/context.ts` — profileId→agentId, profileDir→agentDir, 加 paths, 不加 agentRecord
- `src/kernel/kernel.ts` — KernelConfig 字段改名
- `src/kernel/extension-registry.ts` — provideKernel 方法
- 所有用 profileId/profileDir/ProfilePaths 的扩展和 usecase — mass rename
- `package.json` — 加 chalk，保留 @clack/prompts
- `eslint.config.*` — chalk 仅 CLI + 禁止旧名新写

### 测试（≥18）
- `tests/domain/identity-bootstrap.test.ts`
- `tests/domain/identity-bootstrap-state-machine.test.ts`
- `tests/domain/identity-doc.test.ts`
- `tests/domain/identity-startup.test.ts`
- `tests/domain/identity-migration.test.ts`
- `tests/application/usecases/create-agent.test.ts`
- `tests/application/usecases/init-identity.test.ts`
- `tests/application/usecases/validate-agent.test.ts`
- `tests/application/usecases/configure-agent-lark.test.ts`
- `tests/application/usecases/init-agent.test.ts`
- `tests/application/usecases/delete-agent.test.ts`
- `tests/infrastructure/agent/sqlite-agent-store.test.ts`
- `tests/infrastructure/agent/sqlite-agent-store-concurrency.test.ts`
- `tests/infrastructure/agent/agent-registry.test.ts`
- `tests/infrastructure/identity/file-backed-identity-store.test.ts`
- `tests/infrastructure/paths/home-paths.test.ts`
- `tests/infrastructure/paths/agent-paths.test.ts`
- `tests/infrastructure/paths/trash.test.ts`
- `tests/infrastructure/daemon/ping.test.ts`
- `tests/cli/flows/create-agent-flow.test.ts`
- `tests/cli/flows/identity-flow.test.ts`
- `tests/cli/flows/manage-lark-flow.test.ts`
- `tests/cli/flows/init-agent-flow.test.ts`
- `tests/cli/flows/delete-agent-flow.test.ts`
- `tests/cli/cli-runtime-lifecycle.test.ts`
- `tests/interface/daemon/agent-gate.test.ts`
- `tests/interface/daemon/agent-registry-capability.test.ts`
- `tests/extensions/identity/hydration.test.ts`
- `tests/extensions/identity/transform-mutex.test.ts`
- `tests/extensions/identity/transition.test.ts`
- `tests/extensions/identity/reload.test.ts`
- `tests/extensions/identity/bootstrap-loop.test.ts`
- `tests/extensions/memory/skip-during-bootstrap.test.ts`
- `tests/extensions/frontend.lark/reload.test.ts`
- `tests/extensions/frontend.lark/disable.test.ts`

---

## 20. PR 分片

| 分片 | 内容 | 估时 |
|------|------|------|
| **PR10-0a** | mass rename：标识符 profile→agent（sed 边界替换） | 0.5h |
| **PR10-0b** | 文件/目录重命名 + import 路径 + AgentPaths 字段改名 | 0.5h |
| **PR10-0c** | 注释/字符串/文档 + ESLint 防回潮规则 | 0.5h |
| **PR10-1** | AgentStore port + zod codec + SqliteAgentStore（含 WAL + 乐观锁 + lark 列） + 窄接口 + home-paths + agent-paths 重建 + 迁移 | 4h |
| **PR10-2** | domain 模块（identity-bootstrap / doc / startup / migration）+ 6 个 usecase + 事件契约 | 7h |
| **PR10-3** | prompt-runner + flows（create/identity/lark/manage/init/delete）+ CLI 命令 + lifecycle | 10h |
| **PR10-4** | daemon gate + seed default + bootstrap-loop + identity 扩展改造 + memory recall 拆出 + lark 扩展热加载 + 集成测试 | 7h |
| **合计** | | **~29.5h** |

---

## 21. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Bootstrap loop 无限对话 | `turns_max=6`；`computeNextAction` 返回 `force-finalize` |
| LLM one-shot 输出不符规范 | confirm + zod 校验 front-matter；最多 3 次 refine |
| 用户填的 agent_id 与残留目录冲突 | create 入口检查目录残留并 confirm 清理 |
| `bun:sqlite` 句柄跨命令未释放 | CLI try/finally close；daemon shutdown 中 close |
| Ctrl-C 中断 fs 写入 | `atomicWrite`（write tmp + rename）；prompts onCancel |
| WAL 在 NFS/远程 fs 失效 | fallback 检测 + logger.warn + busy_timeout 仍生效 |
| Daemon vs CLI 并发写冲突 | 乐观锁（WHERE updated_at = ?）+ WAL + busy_timeout 5s |
| Daemon 老启动脚本未带 `-a` | exit code 3 + `--profile` alias 6 周过渡 |
| Bootstrap 抽取 LLM 调用失败 | logger.warn，不递增 turns_completed，下轮重试 |
| Mass rename 漏改 | ESLint 规则封禁旧词；Step 4 验证 grep |
| Identity reload 在 turn 中触发 | turn-边界 lock，不在 turn 中间执行 |
| Reload 过长超时 | 简化：turn 边界检查 pending flag，不需要 await+timeout |
| chalk 在非 TTY 带色码 | chalk v5 默认按 `process.stdout.isTTY` 自动禁用 |
| `@clack/prompts` 曾被 F5 计划删除 | 依赖保留，F5 spec 同步修订 |
