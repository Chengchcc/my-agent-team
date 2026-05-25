# Lobster Spec 02: Agent Core

**版本**: v1.0  
**对应 PRD**: §4 核心概念, §11 子系统适配, §12 现状对应, §13 目录结构  
**依赖**: Spec 01  

---

## 1. 需求概述

重构 `runtime.ts` 拆分出 `AgentCore` 单例类，托管所有重资源（provider, mcp, memory, skills, tools, trace, identity），消除所有模块级单例，建立类型化 EventBus 和 RunContext 跨子系统传递。

---

## 2. 模块范围

```
src/core/
├── agent-core.ts          # AgentCore 主类
├── runtime/
│   ├── run-context.ts     # 跨子系统上下文
│   └── event-bus.ts     # 类型化事件总线
└── bootstrap/
    ├── provider.bootstrap.ts
    ├── mcp.bootstrap.ts
    ├── memory.bootstrap.ts
    ├── skills.bootstrap.ts
    ├── tools.bootstrap.ts
    ├── trace.bootstrap.ts
    └── index.ts           # 统一初始化入口
```

**消除的模块（去单例：
- `src/im/lark/client.ts` - 模块单例 → 移入 LarkBotAdapter
- `src/mcp/manager.ts` - 模块单例 → 移入 AgentCore
- `src/tools/permission-manager.ts` - 模块单例 → 移入 AgentCore
- `src/trace/trace-buffer.ts` - 模块单例 → 移入 AgentCore

---

## 3. 详细设计

### 3.1 AgentCore 接口

```ts
export class AgentCore {
  readonly profileId: string
  readonly config: ResolvedConfig
  
  // 重资源单例
  readonly provider: Provider
  readonly mcp: McpManager
  readonly memory: MemoryStore
  readonly skills: SkillLoader
  readonly tools: ToolRegistry
  readonly permission: PermissionManager
  readonly trace: TraceWriter
  readonly identity: IdentityStore
  
  // 运行时
  readonly events: EventBus

  constructor(profileId: string, config: ResolvedConfig)
  
  createRunContext(sessionId: string, frontendId?: string): RunContext
  
  async shutdown(graceful?: boolean): Promise<void>
}
```

### 3.2 RunContext

```ts
// src/core/runtime/run-context.ts

export type RunContext = {
  sessionId: Ulid
  profileId: string
  frontendId?: FrontendId
  turnId: Ulid
  abortSignal: AbortSignal
}
```

**传递路径：
- Session.enqueue(input, frontendId) → 创建 RunContext
- → 注入到 Agent. turn
- → tool 执行时通过 ctx 访问
- → Trace middleware 读取 sessionId 写入 trace

### 3.3 EventBus

```ts
export class EventBus<T = {
  emit<K extends keyof Events>(type: K, payload: Events[K]): void
  on<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): () => void  off(type: string, handler: Function): void
}

// 事件类型
type Events = {
  'turn:started': { sessionId: Ulid, turnId: Ulid }
  'turn:completed': { sessionId: Ulid, turnId: Ulid, tokens: Tokens }
  'turn:failed': { sessionId: Ulid, turnId: Ulid, error: Error }
  'session:created': { sessionId: Ulid }
  'session:closed': { sessionId: Ulid }
  'identity:changed': { digest: string, effectiveFrom: 'next-turn' }
  'skills:reloaded': { added: string[], removed: string[], updated: string[] }
  'mcp:reloaded': { reconnected: string[], failed: string[] }
  'evolution:progress': { phase: string, pendingSkills: number }
  'evolution:skillProposed': { id: Ulid, name: string, summary: string }
  'system:warn': { code: string, message: string }
}
```

### 3.4 Bootstrap 模块

**初始化顺序**（有依赖）：

```
1. identity.bootstrap.ts   - 无依赖
2. trace.bootstrap.ts      - 无依赖
3. provider.bootstrap.ts   - 无依赖
4. memory.bootstrap.ts     - 无依赖
5. mcp.bootstrap.ts        - 无依赖
6. skills.bootstrap.ts    - 无依赖
7. tools.bootstrap.ts       - 依赖 skills, mcp
```

**bootstrap 接口**:

```ts
// src/core/bootstrap/index.ts
export async function bootstrapAll(
  profileId: string,
  config: ResolvedConfig
): Promise<{
  provider: Provider
  mcp: McpManager
  memory: MemoryStore
  skills: SkillLoader
  tools: ToolRegistry
  permission: PermissionManager
  trace: TraceWriter
  identity: IdentityStore
}>
```

### 3.5 Runtime Thin Wrapper

原有 `createAgentRuntime()` 变成 thin wrapper，兼容现有代码：

```ts
// src/runtime.ts (保留，兼容旧代码)
export async function createAgentRuntime(config: RuntimeConfig): Promise<AgentRuntime> {
  // 内部调用 bootstrapAll + SessionRegistry
  // 返回兼容结构
}
```

---

## 4. 验收标准

- [ ] AgentCore 初始化完整，所有重资源正确注入
- [ ] `knip` 报告剩余模块级单例数量 = 0
- [ ] EventBus 所有事件类型正确，类型安全
- [ ] `bun test tests/core/agent-core.test.ts` 全绿
- [ ] 现有 TUI headless 模式通过 thin wrapper 正常运行
- [ ] `bun run check:arch` 无违规

---

## 5. 不变量

- GI-1: 模块单例全部迁入 AgentCore / Adapter
- GI-3: 重资源 1 profile 1 实例，绝不跨 profile 共享
- GI-4: 轻上下文严格 per-session，AgentCore 不持有 session 状态
- I12: 同 profile sessions 共享同一 AgentCore 全部重资源
