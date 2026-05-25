# Lobster Spec 04: Transport & Protocol

**版本**: v1.0  
**对应 PRD**: §15 ControlPlane/DataPlane, 附录E JSON Schema  
**依赖**: Spec 01, Spec 03  

---

## 1. 需求概述

实现 UnixSocket Transport，ControlPlane 23 个 JSON-RPC methods，DataPlane 事件流，hello 能力协商，完整协议错误码。

---

## 2. 模块范围

```
src/transport/
├── transports/
│   ├── transport.ts         # 抽象接口
│   ├── unix-socket-transport.ts
│   ├── in-memory-transport.ts
│   └── __stubs__/
│       └── tcp-transport.stub.ts  # NotImplemented
├── control-plane/
│   ├── control-plane.ts     # RPC 服务器
│   ├── method-registry.ts   # method 注册
│   └── methods/
│       ├── session.ts       # list/attach/detach/resume/create/close/rename
│       ├── input.ts         # send/cancel
│       ├── permission.ts    # resolve
│       ├── user.ts          # answer
│       ├── system.ts        # health/shutdown/version
│       ├── skills.ts        # reload
│       ├── mcp.ts           # reload
│       ├── identity.ts      # get/set
│       └── evolution.ts     # status/forceReview/acceptPendingSkill/rejectPendingSkill
├── data-plane/
│   ├── data-plane.ts        # 事件流服务器
│   ├── event-types.ts       # 事件类型定义
│   └── cursor-stream.ts     # cursor 流管理
├── capability.ts            # 能力协商
└── index.ts
```

---

## 3. 详细设计

### 3.1 Transport 抽象

```ts
export interface Transport {
  readonly id: string
  
  start(): Promise<void>
  stop(reason?: string): Promise<void>
  
  send(envelope: Envelope): Promise<void>
  onMessage(handler: (envelope: Envelope) => void): void
}

// Envelope (PRD 附录E envelope.schema.json)
type Envelope =
  | { kind: 'rpc'; msg: JsonRpcMessage }
  | { kind: 'event'; ev: DataPlaneEvent }
```

**Transport 实现**:
- `UnixSocketTransport`: 生产环境使用，socket 路径 `data/profiles/<id>/daemon.sock`
- `InMemoryTransport`: TUI 直连使用，跳过序列化
- `TcpTransport` (stub): NotImplementedError

### 3.2 ControlPlane

**错误码实现**:
```ts
export const RpcErrors = {
  // JSON-RPC 标准
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  
  // 自定义
  SESSION_NOT_FOUND: -32000,
  SESSION_BUSY: -32001,
  PERMISSION_TARGET_MISMATCH: -32002,
  CAPABILITY_NOT_NEGOTIATED: -32003,
  PROFILE_MISMATCH: -32004,
}
```

**Hello 协商 (P-I1)**:
```ts
// method: hello
type HelloParams = {
  frontendId: FrontendId
  frontendKind: FrontendKind
  appVersion: string
  capabilities: Capabilities
  lastCursor?: string
}

type HelloResult = {
  daemonVersion: string
  profileId: string
  capabilities: Capabilities  // 取交集
}
```

**P-I1 强制**: hello 成功前所有其他 RPC 返回 `CAPABILITY_NOT_NEGOTIATED`

### 3.3 ControlPlane Methods (23 个)

| 分组 | Methods |
|---|---|
| **Session** (7) | `list`, `attach`, `detach`, `resume`, `create`, `close`, `rename` |
| **Input** (2) | `send`, `cancel` |
| **Permission/Question** (2) | `permission.resolve`, `user.answer` |
| **System** (3) | `health`, `shutdown`, `version` |
| **HotReload** (2) | `skills.reload`, `mcp.reload` |
| **Identity** (2) | `get`, `set` |
| **Evolution** (4) | `status`, `forceReview`, `acceptPendingSkill`, `rejectPendingSkill` |

**Stub 行为**:
- `mcp.reload`: 仅冷重连，进行中 turn 失败
- `skills.reload('profile')`: 显式触发，无 watcher

### 3.4 DataPlane

**事件流 (16 种)**:
```ts
// PRD 附录E event.schema.json
type DataPlaneEvent =
  | { type: 'snapshot'; payload: Snapshot }
  | { type: 'assistant.delta'; payload: { chunk: string; role: 'assistant' } }
  | { type: 'tool.update'; payload: { toolName: string; callId: string; status: 'start'|'end'|'error' } }
  | { type: 'permission.required'; target: FrontendId; payload: PermissionRequired }
  | { type: 'user.question'; target: FrontendId; payload: UserQuestion }
  | { type: 'turn.started'; payload: { turnId: Ulid; inputDigest: string } }
  | { type: 'turn.completed'; payload: { turnId: Ulid; tokens: Tokens; durationMs: number } }
  | { type: 'turn.failed'; payload: { turnId: Ulid; error: ErrorInfo } }
  | { type: 'state.changed'; payload: { from: SessionState; to: SessionState } }
  | { type: 'attach.changed'; payload: { frontendIds: FrontendId[] } }
  | { type: 'identity.changed'; payload: { digest: string; effectiveFrom: 'next-turn' } }
  | { type: 'skills.reloaded'; payload: { added: string[]; removed: string[]; updated: string[] } }
  | { type: 'mcp.reloaded'; payload: { reconnected: string[]; failed: string[] } }
  | { type: 'evolution.progress'; payload: { phase: string; pendingSkills: number } }
  | { type: 'evolution.skillProposed'; payload: { id: Ulid; name: string; summary: string } }
  | { type: 'system.warn'; payload: { code: string; message: string } }
```

**Cursor 语义**:
- attach 时携带 `lastCursor` → replay `(lastCursor, now]`
- `lastCursor` 超出 EventRing 范围 → `system.warn { code: 'cursor.expired' }`
- 缺省 `lastCursor` → 仅推送之后的事件

### 3.5 AJV 验证

**验证点**:
- ControlPlane: method params 入站验证，result 出站验证
- DataPlane: 所有事件 payload 出站验证

**配置**:
- daemon 端：强验证，非法 payload 丢弃 + 日志
- frontend 端：开发环境警告，生产环境宽松（向前兼容）

---

## 4. 验收标准

- [ ] hello 未完成前调用 method 返回 CAPABILITY_NOT_NEGOTIATED
- [ ] 所有 23 个 methods 端到端测试通过
- [ ] 所有 16 种 DataPlane 事件正确发射和接收
- [ ] cursor replay 正确，溢出发出 warn
- [ ] AJV 验证拦截所有非法 payload（测试覆盖）
- [ ] permission.resolve 来源与 target 不匹配被拒绝
- [ ] UnixSocket 并发请求测试不丢失

---

## 5. 不变量

- P-I1: hello 前禁 RPC
- P-I2: permission.resolve 来源必须 = target
- P-I3: 同 reqId 仅首个 resolve 生效
- P-I4: input.cancel 幂等
- P-I5: evId 单调递增
- P-I6: schema 字段只增不减
- P-I7: identity.changed 无 sessionId，session 域事件必有 sessionId
- P-I8: snapshot 仅 attach/resume 后第一帧
