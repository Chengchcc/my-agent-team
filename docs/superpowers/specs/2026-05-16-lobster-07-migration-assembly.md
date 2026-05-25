# Lobster Spec 07: Migration & Assembly

**版本**: v1.0  
**对应 PRD**: §20 渐进迁移路径, §21 风险  
**依赖**: Spec 02, 03, 05, 06  

---

## 1. 需求概述

重写 daemon.ts 组装所有子系统，按 Step 0-7 渐进迁移，保持每一步测试通过，CI 全绿。

---

## 2. 模块范围

```
src/daemon/
├── daemon.ts              # 重写：主入口，组装所有子系统
├── lifecycle.ts           # 启动/关闭流程管理
└── cli.ts                 # CLI 子命令处理 (bun agent)

scripts/
└── check-layers.ts        # ESLint import/no-restricted-paths 配置

tests/e2e/
├── daemon-basic.test.ts   # 基本启动/attach/对话
└── profile-isolation.test.ts  # 多 profile 隔离测试
```

---

## 3. 详细设计

### 3.1 Daemon 主类

```ts
export class Daemon {
  readonly profileId: string
  readonly config: ResolvedConfig
  
  private agentCore: AgentCore
  private evolutionCore: EvolutionCore
  private sessionRegistry: SessionRegistry
  private transport: Transport
  private controlPlane: ControlPlane
  private dataPlane: DataPlane
  private frontends: Map<FrontendId, Frontend>
  
  constructor(profileId: string)
  
  async start(): Promise<void>
  async stop(graceful?: boolean): Promise<void>
  
  getHealth(): HealthReport
}
```

**组装顺序 (有依赖)**:
```
1. 加载 config (profile + global)
2. 创建 AgentCore
3. 创建 SessionRegistry (依赖 AgentCore)
4. 创建 EvolutionCore (依赖 AgentCore)
5. 创建 Transport (UnixSocket)
6. 创建 ControlPlane (依赖 SessionRegistry, EvolutionCore)
7. 创建 DataPlane (依赖 EventBus)
8. 启动所有 frontends (Lark Bots)
9. 就绪
```

### 3.2 CLI 子命令

```json
{
  "scripts": {
    "agent": "bun src/daemon/cli.ts",
    "agent:list": "bun src/daemon/cli.ts list",
    "agent:health": "bun src/daemon/cli.ts health",
    "tui": "bun src/frontend/tui/index.tsx"  // 兼容保留
  }
}
```

**CLI 行为**:
```bash
# 默认 profile，attach main session (自动启动 daemon 如不存在)
bun agent

# 指定 profile
bun agent -p work

# attach 指定 session
bun agent -p work -s <sid>

# 列出当前 profile sessions
bun agent list

# 健康检查
bun agent health

# 停止 daemon
bun agent shutdown
```

### 3.3 Daemon 自动启动

**检测逻辑**:
```ts
function ensureDaemonRunning(profileId: string): Promise<UnixSocketTransport> {
  const socketPath = getSocketPath(profileId)
  
  if (!fs.existsSync(socketPath)) {
    // fork 子进程启动 daemon
    const proc = Bun.spawn([
      'bun',
      'src/daemon/daemon.ts',
      '--profile',
      profileId,
      '--daemon',  // 后台运行
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    
    // 等待 socket 就绪
    await waitForSocket(socketPath, 30000)
  }
  
  // 连接并返回 transport
  return connectToDaemon(socketPath)
}
```

### 3.4 渐进迁移 Step 0-7

| Step | 动作 | 验收 |
|---|---|---|
| **Step 0** | 闭合 Phase 1+2 全部 issue | 现有所有测试全绿 |
| **Step 1** | 新增 `shared/` + 双层 TOML config | `loadConfig()` 工作 |
| **Step 2** | 新增 `core/agent-core.ts` + bootstrap，`runtime.ts` 变 thin wrapper | 现有所有测试仍全绿 |
| **Step 3** | SessionManager → SessionRegistry + Session 类 | 单元测试通过 |
| **Step 4** | Frontend 抽象落地，先 TUI 后 Lark | TUI attach 对话正常 |
| **Step 5** | Transport + ControlPlane/DataPlane | end-to-end 测试通过 |
| **Step 6** | EvolutionCore 抽离顶层平级 | evolution 功能完整 |
| **Step 7** | 删除旧 thin wrapper + dead code | `knip` 报告 dead code = 0 |

**每步要求**:
- 每步完成后 `bun run check:all` 全绿
- 每步可独立 PR
- 每步不破坏现有功能

### 3.5 分层依赖强制 (ESLint)

```ts
// .eslintrc.js
module.exports = {
  rules: {
    'import/no-restricted-paths': [
      'error',
      {
        zones: [
          // shared 不能 import 任何其他层
          { target: './src/shared', from: './src', except: ['./src/shared'] },
          // config 只能 import shared
          { target: './src/config', from: './src', except: ['./src/shared', './src/config'] },
          // core 只能 import config + shared
          { target: './src/core', from: './src', except: ['./src/core', './src/config', './src/shared'] },
          // frontend/transport/evolution 只能 import core + config + shared
          { target: './src/frontend', from: './src', except: ['./src/core', './src/config', './src/shared', './src/frontend'] },
          { target: './src/transport', from: './src', except: ['./src/core', './src/config', './src/shared', './src/transport'] },
          { target: './src/evolution', from: './src', except: ['./src/core', './src/config', './src/shared', './src/evolution'] },
          // daemon 可以 import 所有
        ],
      },
    ],
  },
}
```

### 3.6 HealthCheck 实现

```ts
// system.health 返回
type HealthReport = {
  daemon: 'ok' | 'degraded'
  agentCore: 'ok' | 'degraded'
  sessions: {
    total: number
    running: number
    waiting: number
    idle: number
  }
  providers: { name: string; ok: boolean; lastErr?: string }[]
  mcp: { name: string; ok: boolean; lastErr?: string }[]
  evolution: {
    running: boolean
    lastReviewAt?: string
    cursor?: string
  }
}
```

---

## 4. 验收标准

- [ ] `bun run check:all` 全绿
- [ ] ESLint 分层依赖规则生效，无违规
- [ ] `bun agent` 正常启动，attach main session，对话正常
- [ ] `bun agent list` 正确列出 sessions
- [ ] `bun agent -p work` 启动独立 profile daemon，与 default 隔离
- [ ] detach 后 daemon 继续运行，重新 attach 上下文完整
- [ ] 所有 stub 标有 TODO，注明 MVP 后版本
- [ ] `knip` 报告 dead code = 0

---

## 5. 风险缓解

| 风险 | 缓解 |
|---|---|
| 迁移中破坏现有功能 | thin wrapper 保留，每步保持测试全绿 |
| EventBus 事件遗漏 | `type-only` 测试确保所有事件被处理 |
| UnixSocket 权限问题 | CI 测试覆盖 socket 创建/连接/清理 |
| daemon 僵尸进程 | PID 文件 + 启动时清理死 socket |
| Profile 路径泄露 | ESLint 规则 + 单元测试强制隔离 |
