# Lobster Plan 07: 架构迁移计划

> **原则**: 不兼容旧 CLI 入口，完全采用新架构思维。所有入口直接连接新的 LobsterDaemon。

---

## 一、当前架构 vs 新架构

### 旧架构问题
```
bin/my-agent-tui-dev.ts
  └→ createAgentRuntime()  [全局单例, 无profile隔离]
       └→ runTUIClient(runtime)  [直接耦合]
```

**问题**:
- Runtime 是 God Object，包含所有资源
- 没有清晰的分层边界
- Transport 嵌入在 runtime 内部
- Session 和 Runtime 1:1 绑定
- 无法支持多 Frontend 同时连接

### 新架构 (Lobster)
```
                    ┌──────────────────────────────────┐
                    │      LobsterDaemon (per Profile) │
                    │  ┌───────────────────────────┐   │
┌──────────────┐   │  │     AgentCore             │   │   ┌─────────────┐
│ TUI Client   │───┼─▶│  ┌────────────────────┐   │   │◀──│ LarkBot X   │
└──────────────┘   │  │  │ Session A          │   │   │   └─────────────┘
                    │  │  │ Session B          │   │   │
┌──────────────┐   │  │  └────────────────────┘   │   │   ┌─────────────┐
│ LarkBot A    │───┼─▶│  EvolutionCore (平级)    │   │◀──│ LarkBot Y   │
└──────────────┘   │  └───────────────────────────┘   │   └─────────────┘
                    │                                   │
                    │  Transport Layer (UnixSocket)      │
                    └───────────────────────────────────┘
```

---

## 二、模块迁移总览

| 阶段 | 模块 | 操作 | 优先级 |
|---|---|---|---|
| **P0** | `src/core/` | 集成 Agent 逻辑到 AgentCore | P0 |
| **P0** | `src/daemon/lobster-daemon.ts` | 完善 Daemon 组装逻辑 | P0 |
| **P0** | `bin/lobster-tui.ts` | 新 TUI 入口 (通过 Transport 连接) | P0 |
| **P1** | `src/frontend/tui/` | TUI Adapter 完整实现 | P1 |
| **P1** | `src/frontend/lark/` | LarkBot Adapter 完整实现 | P1 |
| **P1** | `bin/lobster-lark.ts` | Lark Bot 入口 | P1 |
| **P2** | `src/core/bootstrap/*.ts` | Provider/Memory/MCP/Skills 完整集成 | P2 |
| **P2** | `src/evolution/evolution-core.ts` | Evolution 完整集成 | P2 |
| **P3** | 清理旧代码 | 删除旧 runtime/agent/im/ 等 | P3 |

---

## 三、P0 阶段: 核心链路打通

### Task 7.1: AgentCore 集成真实 Agent 逻辑

**文件**: `src/core/agent-core.ts`

**目标**: AgentCore 不再是 Stub，而是真正承载 Agent 运行

```typescript
// 当前: 只做资源初始化
// 需要: 集成 Agent Loop + Session 运行时

export class AgentCore {
  // 新增:
  createAgentForSession(sessionId: string): AgentRunLoop
  submitUserInput(sessionId: string, input: string): Promise<void>
  cancelTurn(sessionId: string): void
}
```

**需要迁移的逻辑** (从 `src/runtime.ts` + `src/agent/`):
- `src/agent/Agent.ts` → 移入 `core/agent/`
- `src/agent/agent-loop.ts` → 移入 `core/agent/`
- `src/agent/context.ts` → 改为 Session 级别 ContextManager
- `src/agent/tool-registry.ts` → 合并入 `core/bootstrap/tools.bootstrap.ts`
- `src/agent/dispatch.ts` → 移入 `core/agent/`

**注意**: 每个 Session 有独立的 `ContextManager`，但共享 `ToolRegistry`

---

### Task 7.2: 完善 LobsterDaemon

**文件**: `src/daemon/lobster-daemon.ts`

**目标**: Daemon 成为真正的运行宿主

```typescript
export class LobsterDaemon {
  // 新增:
  onEvent(handler: (event: DataPlaneEvent) => void): void

  // RPC 方法委托给 ControlPlane:
  sendInput(sessionId: string, content: string): void
  cancelInput(sessionId: string): void
  createSession(title?: string): string
  closeSession(sessionId: string): void
  listSessions(): SessionMeta[]
  attachFrontend(frontendId: string, sessionId?: string): void
  detachFrontend(frontendId: string): void

  // Daemon 生命周期:
  ensureRunning(): void
  waitForShutdown(): Promise<void>
}
```

---

### Task 7.3: 新 TUI 入口实现

**文件**: `bin/lobster-tui.ts`

```typescript
#!/usr/bin/env bun
import 'dotenv/config';
import { TuiAdapter } from '../src/frontend/tui';
import { InMemoryTransport } from '../src/transport';
import { createLobsterDaemon } from '../src/daemon';
import { getSettings, DEFAULT_PROFILE_ID } from '../src/config';

// 1. 加载配置
const config = getSettings(DEFAULT_PROFILE_ID);

// 2. 创建 Daemon (同进程 InMemoryTransport)
const transport = new InMemoryTransport('tui-main');
const daemon = await createLobsterDaemon(DEFAULT_PROFILE_ID, config, {
  transport: 'memory',
  enableEvolution: true,
});

// 3. 创建 TUI Adapter
const tui = new TuiAdapter();
await tui.start(transport);

// 4. 优雅关闭
process.on('SIGINT', async () => {
  await tui.stop();
  await daemon.stop(true);
  process.exit(0);
});
```

**关键点**: 没有中间层！TUI **完全通过 Transport 协议** 与 Daemon 通信

---

## 四、P1 阶段: Frontend 完整实现

### Task 7.4: TuiAdapter 完整实现

**文件**: `src/frontend/tui/tui-adapter.ts`

**需要迁移的代码** (`src/cli/tui/` → `frontend/tui/`):

| 原文件 | 目标 | 说明 |
|---|---|---|
| `src/cli/tui/App.tsx` | `frontend/tui/App.tsx` | Ink 根组件，改为订阅 Transport 事件 |
| `src/cli/tui/state/store.ts` | `frontend/tui/state/store.ts` | Zustand store，数据源改为 RPC 调用 |
| `src/cli/tui/hooks/use-agent-subscription.ts` | `frontend/tui/hooks/use-transport-subscription.ts` | 改为订阅 DataPlane 事件 |
| `src/cli/tui/views/` | `frontend/tui/views/` | 全部迁移，数据源改为 store |
| `src/cli/tui/markdown/` | `frontend/tui/markdown/` | 直接迁移 |
| `src/cli/tui/components/` | `frontend/tui/components/` | 直接迁移 |
| `src/cli/tui/commands/` | `frontend/tui/commands/` | 改为调用 RPC 方法 |

**架构调整**:
```
旧: TUI → 直接调用 runtime.agent.*
新: TUI → Adapter.call('session.send', {...})
                      ↓
              Transport Protocol
                      ↓
              ControlPlane → Session → Agent
```

---

### Task 7.5: LarkBot Adapter 完整实现

**文件**: `src/frontend/lark/lark-bot-adapter.ts`

**需要迁移的代码** (`src/im/lark/` → `frontend/lark/`):

| 原文件 | 目标 | 说明 |
|---|---|---|
| `src/im/lark/client.ts` | `frontend/lark/lark-client.ts` | 去掉单例，每个 Adapter 独立实例 |
| `src/im/lark/card-builder.ts` | `frontend/lark/card-pipeline.ts` | 卡片渲染流水线 |
| `src/im/lark/event-dispatcher.ts` | `frontend/lark/event-handler.ts` | Lark WebSocket 事件 → Daemon RPC |
| `src/im/lark/message-parser.ts` | `frontend/lark/message-parser.ts` | 直接迁移 |

**核心变化**:
```typescript
// 旧: client.ts 直接调用 runtime
this.runtime.agent.sendMessage(...)

// 新: 通过 Transport 协议
this.call('session.send', {
  sessionId: this.routingTable.getSessionId(anchor),
  content: parsedMessage,
})
```

---

### Task 7.6: Lark Bot 独立入口

**文件**: `bin/lobster-lark.ts`

```typescript
#!/usr/bin/env bun
import 'dotenv/config';
import { LarkBotAdapter } from '../src/frontend/lark';
import { UnixSocketTransport } from '../src/transport';
import { getSettings, DEFAULT_PROFILE_ID } from '../src/config';

// 1. 加载配置
const config = getSettings(DEFAULT_PROFILE_ID);

// 2. 连接到已运行的 Daemon (UnixSocket)
const transport = new UnixSocketTransport('data/profiles', DEFAULT_PROFILE_ID);
await transport.connect(); // Client 模式 (非 Server)

// 3. 启动 Lark Bot Adapter
const bot = new LarkBotAdapter(config.lark.bots[0]);
await bot.start(transport);

console.log(`Lark Bot ${bot.id} connected to profile ${DEFAULT_PROFILE_ID}`);
```

---

## 五、P2 阶段: Bootstrap 深度集成

### Task 7.7: Provider Bootstrap 完整实现

**文件**: `src/core/bootstrap/provider.bootstrap.ts`

**从 `src/runtime.ts` + `src/providers/` 迁移**:
- LLM Provider 创建逻辑
- Thinking decoder 配置
- Token 计数

---

### Task 7.8: Memory Bootstrap 完整实现

**文件**: `src/core/bootstrap/memory.bootstrap.ts`

**从 `src/runtime-setup.ts` 迁移**:
- `setupMemory()` 逻辑
- SqliteMemoryStore 初始化
- BM25/Vector/Hybrid Retrievers
- MemoryMiddleware

---

### Task 7.9: MCP Bootstrap 完整实现

**文件**: `src/core/bootstrap/mcp.bootstrap.ts`

**从 `src/runtime-setup.ts` 迁移**:
- `assembleMcp()` 逻辑
- 所有 MCP 工具注册
- Resource catalog 注入

---

### Task 7.10: Skills Bootstrap 完整实现

**文件**: `src/core/bootstrap/skills.bootstrap.ts`

**从 `src/runtime-setup.ts` 迁移**:
- SkillLoader 初始化
- SkillMiddleware 创建
- SKILL.md 扫描与加载

---

### Task 7.11: EvolutionCore 完整集成

**文件**: `src/evolution/evolution-core.ts`

**需要集成**:
- 订阅 `AgentCore.events` 的 turn 相关事件
- 连接 CursorStore → PersistentQueue → Drainer
- 触发 Review 逻辑
- 输出 Skill Proposal 事件

---

## 六、P3 阶段: 代码清理与验证

### Task 7.12: 删除旧代码

**可以安全删除的文件**:
```
src/runtime.ts              ← 完全废弃
src/runtime-setup.ts        ← 移到 core/bootstrap/
src/runtime-providers.ts     ← 移到 core/bootstrap/
src/agent/                   ← 移到 core/agent/
src/im/                      ← 移到 frontend/lark/
src/session/                 ← 移到 core/session/
src/config/loader.ts         ← TOML 完全替代
src/config/schema.legacy.ts  ← 删除
src/config/defaults.legacy.ts ← 删除
```

**需要保留但重构的**:
```
src/mcp/          → 集成到 AgentCore + MCP Bootstrap
src/memory/       → 集成到 Memory Bootstrap
src/skills/       → 集成到 Skills Bootstrap
src/tools/        → 集成到 Tools Bootstrap
src/trace/        → 集成到 Trace Bootstrap
src/providers/    → 集成到 Provider Bootstrap
```

---

### Task 7.13: 架构约束验证

**运行检查**:
```bash
# 验证无循环依赖
bun run check:arch

# 验证所有文件 < 400 行
wc -l src/**/*.ts src/**/*.tsx | sort -n

# 验证无未使用导出
bun knip --exclude dependencies,files

# 完整测试套件
bun test tests/shared/ tests/config/ tests/core/ tests/transport/ tests/frontend/ tests/daemon/
```

---

## 七、关键架构决策点

### 决策 1: Daemon 运行模式
```
模式 A: 同进程 (TUI 启动时创建 Daemon)
  - 优点: 简单，不需要额外启动命令
  - 缺点: TUI 退出 Daemon 也退出

模式 B: 独立 Daemon 进程 (推荐)
  - 优点: 多 Frontend 同时连接，后台运行
  - 缺点: 需要 `lobster daemon start/stop` 命令

→ 采用模式 B，实现 `lobster` CLI 命令集
```

### 决策 2: Session 的 Context 存储
```
选项 A: 全部保存在 Daemon 内存 (推荐 MVP)
  - 优点: 简单，快速
  - 缺点: Daemon 重启丢失 Context

选项 B: SQLite 持久化
  - 优点: 重启恢复
  - 缺点: 复杂度高

→ MVP 用选项 A，Phase 2 实现选项 B
```

### 决策 3: Frontend 断线重连
```
→ 必须实现:
  - Frontend 检测断线 → 自动重连
  - Replay 丢失的事件 (通过 EventRing cursor)
  - Session 状态恢复
```

---

## 八、迁移顺序建议

```
Phase 1: 核心链路 (能跑 Hello World)
  ↓
  7.1 AgentCore 集成 Agent Loop
  7.2 LobsterDaemon 完善
  7.3 新 TUI 入口 (最简版)
  ↓
✅ 验证: 可以通过 TUI 输入 "hi" 并获得回复

Phase 2: Frontend 完整 (完整 TUI + Lark)
  ↓
  7.4 TuiAdapter 完整实现 + 全量迁移
  7.5 LarkBot Adapter 完整实现
  7.6 Lark Bot 独立入口
  ↓
✅ 验证: TUI 所有功能正常，Lark Bot 能收发消息

Phase 3: 全功能集成 (Evolution + 全部子系统)
  ↓
  7.7 Provider Bootstrap
  7.8 Memory Bootstrap
  7.9 MCP Bootstrap
  7.10 Skills Bootstrap
  7.11 EvolutionCore 完整集成
  ↓
✅ 验证: Evolution 能自动 Review + 生成 Skill

Phase 4: 清理
  ↓
  7.12 删除旧代码
  7.13 架构验证
  ↓
✅ 完成: Lobster 架构正式上线 🦞
```

---

## 九、目录结构终态

```
src/
├── shared/              ✅ Done
├── config/              ✅ Done (TOML)
├── core/                🚧 P0
│   ├── agent/           ← Agent Loop, Context, Dispatch
│   ├── bootstrap/       ✅ Done (需要完善)
│   ├── runtime/         ✅ Done (EventBus, RunContext)
│   ├── session/         ✅ Done (Session, Registry, EventRing)
│   ├── agent-core.ts    🚧 P0
│   └── index.ts
├── transport/           ✅ Done (协议层)
├── frontend/            🚧 P1
│   ├── tui/             ← 全量从 src/cli/tui/ 迁移
│   └── lark/            ← 全量从 src/im/lark/ 迁移
├── evolution/           🚧 P2
├── mcp/                 → 移到 bootstrap
├── memory/              → 移到 bootstrap
├── skills/              → 移到 bootstrap
├── tools/               → 移到 bootstrap
├── trace/               → 移到 bootstrap
├── providers/           → 移到 bootstrap
└── daemon/              🚧 P0
    ├── lobster-daemon.ts
    └── cli.ts           ← lobster 命令行工具
```
