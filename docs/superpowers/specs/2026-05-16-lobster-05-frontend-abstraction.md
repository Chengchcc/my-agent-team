# Lobster Spec 05: Frontend Abstraction

**版本**: v1.0  
**对应 PRD**: §8 LarkBotAdapter, §12 现状对应  
**依赖**: Spec 04  

---

## 1. 需求概述

建立 Frontend 防腐层接口，把 TUI 和 LarkBot 从直接依赖 AgentRuntime 重构为通过 Transport 协议接入，实现 Bot:Agent = N:1 多实例。

---

## 2. 模块范围

```
src/frontend/
├── frontend.ts            # Frontend 接口定义
├── adapter-base.ts        # 适配器基类
├── tui/                   # TUI 适配器
│   ├── tui-adapter.ts
│   └── ... (现有 tui 代码迁移，按需)
├── lark/
│   ├── lark-bot-adapter.ts
│   ├── lark-client.ts     # 去单例，每个 adapter 一个实例
│   ├── routing-table.ts   # anchor → sessionId 映射
│   ├── card-pipeline.ts   # 卡片渲染流水线
│   └── event-handler.ts   # Lark 事件处理
├── webui/__stubs__/       # NotImplemented
└── index.ts
```

**迁移的旧模块**:
- `src/cli/tui/*` → 迁移为 TUI Adapter
- `src/im/lark/*` → 迁移为 LarkBot Adapter

---

## 3. 详细设计

### 3.1 Frontend 接口 (防腐层)

```ts
export interface Frontend {
  readonly id: FrontendId
  readonly kind: 'tui' | 'lark-bot' | 'webui'
  
  start(transport: Transport): Promise<void>
  stop(reason?: string): Promise<void>
  
  // DataPlane 事件回调
  onEvent(event: DataPlaneEvent): void
}
```

### 3.2 Adapter 基类

```ts
export abstract class FrontendAdapter implements Frontend {
  readonly id: FrontendId
  abstract readonly kind: string
  
  protected transport?: Transport
  protected attachedSession?: Ulid
  
  async start(transport: Transport): Promise<void>
  async stop(reason?: string): Promise<void>
  
  // 子类实现
  abstract onEvent(event: DataPlaneEvent): void
  
  // RPC 辅助方法
  protected call<T>(method: string, params: unknown): Promise<T>
  protected notify(method: string, params: unknown): void
}
```

### 3.3 TUI Adapter

**核心变化**: TUI 不再持有 AgentRuntime，**完全无状态**

```ts
// src/frontend/tui/tui-adapter.ts
export class TuiAdapter extends FrontendAdapter {
  readonly kind = 'tui'
  
  // 渲染状态 (仅前端持有，daemon 不关心)
  private messages: Map<Ulid, UIMessage> = new Map()
  private isTyping: boolean = false
  private permissionPrompt?: PermissionRequired
  
  async start(transport: Transport): Promise<void> {
    await super.start(transport)
    
    // 启动流程: hello → attach main
    await this.call('hello', {
      frontendId: this.id,
      frontendKind: 'tui',
      appVersion: '1.0.0',
      capabilities: { render: ['markdown', 'code'] },
    })
    
    const result = await this.call('session.attach', {})
    this.attachedSession = result.sessionId
  }
  
  onEvent(event: DataPlaneEvent): void {
    switch (event.type) {
      case 'snapshot': this.renderSnapshot(event.payload); break
      case 'assistant.delta': this.renderDelta(event.payload); break
      case 'permission.required': this.showPermission(event.payload); break
      // ... 所有事件类型
    }
  }
  
  // 用户输入
  private onUserInput(text: string): void {
    this.notify('input.send', {
      sessionId: this.attachedSession,
      text,
    })
  }
}
```

**CLI 启动流程**:
```
bun agent
  ↓
检测 daemon.sock 不存在
  ↓
fork daemon 进程 (后台)
  ↓
创建 InMemoryTransport / UnixSocketTransport
  ↓
创建 TuiAdapter
  ↓
adapter.start(transport) → hello → attach → 开始对话
```

### 3.4 LarkBot Adapter

**Bot:Agent = N:1** 架构：

```ts
// src/frontend/lark/lark-bot-adapter.ts
export class LarkBotAdapter extends FrontendAdapter {
  readonly kind = 'lark-bot'
  
  private client: LarkClient  // 每个 adapter 自己的实例
  private routingTable: RoutingTable
  
  constructor(config: BotConfig) {
    super()
    this.client = new LarkClient(config.appId, config.appSecret)  // 去单例！
    this.routingTable = new RoutingTable()
  }
  
  async start(transport: Transport): Promise<void> {
    await super.start(transport)
    
    // hello 协商
    await this.call('hello', {
      frontendId: this.id,
      frontendKind: 'lark-bot',
      appVersion: '1.0.0',
      capabilities: { render: ['card'] },
    })
    
    // 启动 Lark WebSocket 接收消息
    this.client.startWebSocket(event => this.handleLarkEvent(event))
  }
  
  private handleLarkEvent(event: LarkEvent): void {
    // 解析 anchor
    const anchor = this.parseAnchor(event)
    
    // 路由: (botId, scope, key) → sessionId
    let sessionId = this.routingTable.get(anchor)
    if (!sessionId) {
      sessionId = this.createSessionForAnchor(anchor)
    }
    
    // 发送到 ControlPlane
    this.notify('input.send', {
      sessionId,
      text: event.message.content,
    })
  }
}
```

**路由表 RoutingTable**:
```ts
// scope = 'p2p'   → 私聊 → main session
// scope = 'chat'  → 群聊 → main session
// scope = 'thread' → 群话题 → 独立 session

type AnchorKey = `${FrontendId}:${string}:${string}`  // botId:scope:key

export class RoutingTable {
  private map = new Map<AnchorKey, Ulid>()
  
  get(anchor: Anchor): Ulid | undefined
  set(anchor: Anchor, sessionId: Ulid): void
}
```

### 3.5 CardPipeline

每个 LarkBotAdapter 持有独立的 CardPipeline，不再共享：

```ts
export class CardPipeline {
  private pendingCards = new Map<Ulid, CardState>()
  
  update(event: AgentEvent): LarkCard | null
  flush(sessionId: Ulid): LarkCard[]
}
```

---

## 4. 验收标准

- [ ] TUI 启动流程完整：检测 socket → 启动 daemon → hello → attach → 对话
- [ ] TUI detach 后 daemon 继续运行，重新 attach 上下文完整恢复
- [ ] Lark 私聊消息路由到 main session
- [ ] Lark thread 消息路由到独立 session
- [ ] 2 个不同 Bot 配置在同一 daemon 运行，互不干扰
- [ ] 权限弹卡精确送达发起 turn 的 frontend
- [ ] `knip` 报告旧模块单例引用 = 0

---

## 5. Stub 行为

- Permission 无对应 frontend → 直接拒绝权限请求 (S-3)
- AskUserQuestion 超时 → 仅日志，不重试 (S-5)
- WebUI Adapter → NotImplementedError
