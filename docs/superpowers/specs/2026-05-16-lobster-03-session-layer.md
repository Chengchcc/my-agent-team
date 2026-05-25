# Lobster Spec 03: Session Layer

**版本**: v1.0  
**对应 PRD**: §5 Session 状态机, §11 子系统适配 (Context/Tools/Permission)  
**依赖**: Spec 02  

---

## 1. 需求概述

实现 Session 状态机，单 in-flight turn 模型，FIFO 输入队列，权限/问答路由，EventRing 事件缓存。

---

## 2. 模块范围

```
src/core/session/
├── session-registry.ts    # Session 管理器，anchor 路由
├── session.ts            # Session 类，状态机
├── context-manager.ts     # per-session 消息存储 (从 agent/ 迁移)
├── sub-tool-registry.ts   # 子工具表，fork 自主表
├── event-ring.ts         # 环形事件缓冲区
├── attached-frontends.ts  # attach 管理
├── types.ts              # SessionState, UserInput 等
└── index.ts
```

---

## 3. 详细设计

### 3.1 SessionState 状态机

```ts
export enum SessionState {
  INIT = 'INIT',
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
  WAITING = 'WAITING',
  CLOSED = 'CLOSED',
}
```

**转移图**:
```
INIT → IDLE → RUNNING ⇄ WAITING
         ↑       ↓
         └───────┘  (turn done)
       任意态 → CLOSED  (main 除外)
```

### 3.2 Session 类

```ts
export class Session {
  readonly sessionId: Ulid
  readonly isMain: boolean
  readonly title?: string
  readonly anchor?: Anchor
  
  state: SessionState
  lastInputFrontendId?: FrontendId
  
  pendingInputs: UserInput[]  // FIFO 队列
  attachedFrontends: Set<FrontendId>
  
  context: ContextManager     // per-session messages
  subTools: SubToolRegistry  // fork 自主表
  ring: EventRing            // 事件环形缓冲
  
  private currentTurn?: { turnId: Ulid, abortController: AbortController }

  constructor(opts: {
    sessionId: Ulid
    isMain: boolean
    title?: string
    anchor?: Anchor
    agentCore: AgentCore
  })

  enqueue(input: UserInput, frontendId: FrontendId): void
  abort(reason?: string): void
  attach(frontendId: FrontendId): void
  detach(frontendId: FrontendId): void
  close(): Promise<void>
  
  private processNextInput(): Promise<void>
}
```

**单 in-flight 逻辑**:
- `enqueue()` 时 state = IDLE → 立即 `processNextInput()`
- `enqueue()` 时 state = RUNNING → 推入 `pendingInputs`
- turn 完成时 → 若 pendingInputs 非空 → `processNextInput()`
- `abort()` 取消当前 turn，不丢 pendingInputs

### 3.3 SessionRegistry

```ts
export class SessionRegistry {
  private sessions: Map<Ulid, Session>
  private anchorMap: Map<string, Ulid>  // (botId, scope, key) → sessionId
  
  constructor(private agentCore: AgentCore)

  get(sessionId: Ulid): Session | undefined
  list(filter?: { isMain?: boolean; anchorScope?: string }): SessionMeta[]
  create(opts?: { title?: string; anchor?: Anchor; setMain?: boolean }): Session
  close(sessionId: Ulid): void
  
  routeByAnchor(anchor: Anchor): Session | undefined
  getMainSession(): Session
}
```

### 3.4 EventRing

```ts
export class EventRing {
  private buffer: DataPlaneEvent[]
  private cursor: number = 0
  private maxSize: number = 1000  // MVP 默认
  
  push(event: DataPlaneEvent): void
  
  // 返回 (cursor, now] 的事件
  replaySince(cursor: string): DataPlaneEvent[]
  
  // 返回最近 N 条消息的 snapshot
  getTailSnapshot(messageCount: number = 50): Snapshot
}
```

**Stub 行为**:
- 缓冲区满时 push → emit `system.warn { code: 'cursor.expired' }`
- MVP 不做 trace file replay

### 3.5 SubToolRegistry

```ts
export class SubToolRegistry {
  private parent: ToolRegistry
  private sessionTools: Map<string, Tool>
  
  fork(): Tool[]  // 合并 parent + session 工具
  register(tool: Tool): void  // 仅本 session 可见，不污染 parent
}
```

### 3.6 权限与问答路由

```ts
// Session 内部
private emitPermissionRequired(reqId: Ulid, toolName: string, summary: string) {
  this.agentCore.events.emit('permission:required', {
    target: this.lastInputFrontendId,  // 精确路由
    sessionId: this.sessionId,
    reqId,
    toolName,
    summary,
    choices: ['allow', 'deny'],
  })
}
```

**Stub 行为**:
- `lastInputFrontendId` 不存在 → 直接拒绝权限请求 (S-3)

---

## 4. 验收标准

- [ ] 状态机所有转移路径单元测试覆盖
- [ ] RUNNING 时 enqueue 正确入队，turn 完成后自动处理下一条
- [ ] abort() 取消当前 turn，pendingInputs 不丢失
- [ ] 同 session 被两个 frontend attach，两者都收到事件
- [ ] 权限请求只发送给 `lastInputFrontendId`
- [ ] main session 调用 close() 抛出错误
- [ ] EventRing replay 正确，溢出发出 warn

---

## 5. 不变量

- I2: 同 profile ≤1 main session，main 不可关闭
- I4: 单 in-flight per session，新输入必进 FIFO
- I5: permission/question 路由到 `lastInputFrontendId`
- I6: Session crash 不影响 AgentCore / 其他 Session
- I-TR1: 子工具表只读主表，不污染
