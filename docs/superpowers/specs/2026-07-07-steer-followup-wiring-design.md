# Spec: Steer / FollowUp 接线 — 让用户在 Agent 运行中插入消息和追加任务

> 状态：待评审
> 关联：ADR 0011（Web IA Work/Chat/Team）、conversation service（`service.ts` ConversationBusyError）
> 设计约束：`docs/architecture/design-philosophy.md` —— 暴露业务、隐藏机制

## 1. 问题

harness 层有完整的 steer/followUp 机制（`AgentSession.steer()` / `AgentSession.followUp()` / `SteeringQueue` / `FollowUpQueue` / `queue_update` 事件），但整条链没接通到前端：

- 后端 conversation `postMessage` 在会话 busy（`lock.isActive`）时抛 `ConversationBusyError`（409）
- 前端 `ConversationCanvas.send()` 遇到 409 报错
- 用户在 agent 运行中发消息会被**拒绝**，无法 steer
- agent 完成后用户无法 followUp（追加任务），只能发新 prompt（触发新 span）
- `queue_update` 事件已在 harness 发出，但前端没有消费

## 2. 目标

- **steer**：agent 运行中，用户发消息 → 消息进入 steering 队列，agent 在下一个 step 消费
- **followUp**：agent 完成后，用户发消息 → 消息进入 follow-up 队列，触发新一轮 run（复用同一 session）
- 前端 `send()` 自动判断：busy → steer，idle → followUp 或 prompt
- `queue_update` 事件在前端展示排队中的消息

## 3. 现状事实

| 事实 | 位置 | 说明 |
|---|---|---|
| `AgentSession.steer(text)` | `harness/agent-session.ts:210` | 运行中插入 steering 消息，抛错如不在运行态 |
| `AgentSession.followUp(text)` | `harness/agent-session.ts:218` | agent 初始化后追加 follow-up 消息 |
| `AgentSession.prompt()` 在运行中自动路由到 steer | `agent-session.ts:137-139` | `if running → this.steer(text); return` |
| `SteeringQueue` / `FollowUpQueue` | `framework/agent-options.ts` | drain() 消费式取出 |
| `queue_update` 事件 | `agent-session.ts:96-100` | 含 steering + followUp 队列内容 |
| conversation `postMessage` 遇 busy 抛 409 | `service.ts:208-209` | `lock.isActive → throw ConversationBusyError` |
| `startAgentRun` 创建 session 并 prompt | `conversation-compose.ts:139-186` | session 存在 SessionManager 里 |
| 前端 `send()` 调 `postMessage` | `hooks/useConversation.ts` | 遇 409 报 toast 错误 |
| SessionManager 有 `get(sessionId)` | `span/session-manager.ts` | 可按 sessionId 取活跃 session |

## 4. 设计

### 4.1 后端：conversation service 加 steer/followUp

**方案**：在 `postMessage` 遇到 busy 时不抛错，改为查找活跃 session 并 steer。

但 `conversation service` 不直接持有 session 引用——`startAgentRun` 是注入的回调，session 存在 SessionManager 里。需要让 conversation service 能访问活跃 session。

**方案 A（推荐）**：`startAgentRun` 回调里把 session 的 steer/followUp 方法暴露给 conversation service。

`conversation-compose.ts` 的 `startAgentRun` 闭包里已经创建了 session（`sessionManager.create/open`）。在创建 session 后，把 `session.steer` / `session.followUp` 注册到一个 `Map<conversationId, { steer, followUp }>` 里。session dispose 时清除。

```typescript
// conversation-compose.ts 新增
const activeSessions = new Map<string, { steer: (text: string) => void; followUp: (text: string) => void }>();

// startAgentRun 里，session 创建后：
activeSessions.set(conversationId, {
  steer: (text: string) => session.steer(text),
  followUp: (text: string) => session.followUp(text),
});
// session dispose 时清除（通过 supervisor.onReap 或在 run-accumulator 的 finally 里）
```

**方案 B**：直接用 SessionManager.get(sessionId) ——但 conversation service 不知道 sessionId（只有 conversationId）。

选方案 A——最小侵入，不改变 SessionManager 接口。

### 4.2 后端：postMessage 遇 busy 时 steer

`conversation service.ts` 的 `postMessage`：

```typescript
// 当前：
if (lock.isActive(input.conversationId)) {
  throw new ConversationBusyError(input.conversationId);
}

// 改为：
if (lock.isActive(input.conversationId)) {
  const active = activeSessions.get(input.conversationId);
  if (active) {
    // 消息写入 ledger（让用户看到自己发的消息）
    await appendAndBroadcast({ ... });
    // steer 到运行中的 session
    active.steer(text);
    return { seq, triggeredRuns: [] };
  }
  throw new ConversationBusyError(input.conversationId);
}
```

### 4.3 后端：followUp

agent 完成后（`lock` 释放），用户发新消息时：
- 如果 session 还在内存（没 dispose），调 `session.followUp(text)` 触发新一轮 run
- 如果 session 已 dispose，走正常的 `postMessage` → `startAgentRun` 创建新 session

`postMessage` 在非 busy 时：
```typescript
// 如果 session 还活着，用 followUp（复用 session 记忆）
const active = activeSessions.get(input.conversationId);
if (active) {
  await appendAndBroadcast({ ... });
  active.followUp(text);
  return { seq, triggeredRuns: [] };
}
// 否则走正常的 forkAgentRuns
```

### 4.4 后端：activeSessions 生命周期管理

- **注册**：`startAgentRun` 里 session 创建后注册
- **清除**：`supervisor.onReap` 回调里清除（main.ts 已有 `onReap: (_runId, sessionId) => sessionManager.dispose(sessionId)`）
- 或在 `run-accumulator.ts` 的 `onRunComplete` finally 里清除

最简方案：在 `conversation-compose.ts` 的 `startAgentRun` 里注册，在 supervisor 的 `onRunComplete` 回调里清除。

### 4.5 前端：排队消息 UI（可编辑队列）

用户在 agent 运行中发的消息不直接进入对话流，而是进入一个**可视化的排队区域**，支持编辑和撤回。

#### 排队区域设计

```
┌─────────────────────────────────────────┐
│  Timeline（对话流）                       │
│  ...agent 正在运行...                      │
│                                          │
├─────────────────────────────────────────┤
│  📋 Queued messages (2)                  │  ← 排队区域，半透明背景
│  ┌─────────────────────────────────────┐│
│  │ ✏️ "先检查测试文件"          [✕]    ││  ← 可编辑 + 可撤回
│  └─────────────────────────────────────┘│
│  ┌─────────────────────────────────────┐│
│  │ ✏️ "然后跑 bun test"         [✕]    ││
│  └─────────────────────────────────────┘│
├─────────────────────────────────────────┤
│  [输入框: Steer the agent...]   [Send]  │  ← 运行中 placeholder
└─────────────────────────────────────────┘
```

#### 交互细节

- **排队消息以半透明气泡显示**在 Timeline 底部、输入框上方，视觉上区分于已发送消息
- **每条排队消息可编辑**：点击进入编辑态，修改后保存回队列
- **每条排队消息可撤回**：点 ✕ 按钮从队列移除
- **agent 消费一条排队消息后**，该消息从排队区域消失，转为正常消息出现在 Timeline 里
- **排队区域为空时折叠**，不占空间
- **运行中输入框** placeholder 改为 "Steer the agent..."
- **完成后输入框** placeholder 改回 "Send a message..."

#### 数据流

- 用户在运行中点 Send → 消息加入排队区域（乐观更新）+ 调后端 postMessage（后端自动 steer）
- `queue_update` 事件更新排队区域内容（`{ steering: string[], followUp: string[] }`）
- agent drain 一条 steering → 后端不单独通知，前端通过 queue_update 的 steering 数组变短判断
- 编辑排队消息 → 更新前端本地状态 + 重新调 postMessage（追加新 steer）
- 撤回排队消息 → 从前端本地状态移除（best-effort：harness steering queue 已 push 不可撤回）

#### 编辑/撤回的技术路径

harness 的 `SteeringQueue` 是消费式的（drain 取走即清空），不支持编辑已排队的消息。

- **方案 A（推荐）**：前端本地管理排队队列。Send → 调 postMessage + 本地追加到 queuedMessages。编辑 → 更新本地 + 重新 postMessage（追加新内容）。撤回 → 从本地移除。前端是排队 UI 的 single source of truth。
- **方案 B**：给 SteeringQueue 加 edit/remove 方法。harness 改动更大，不值得。

选方案 A——不为了 UI 编辑能力改 harness 的核心数据结构。

### 4.6 前端：send() 自动路由

前端 `send()` 不需要区分 steer/followUp/prompt——后端 `postMessage` 自动路由：
- busy → steer（消息进入 steering 队列）
- idle + session 活着 → followUp
- idle + session 不在 → prompt（创建新 session）

前端只需处理排队 UI 和 placeholder 切换。

## 5. 后端变更

| 文件 | 改动 |
|---|---|
| `conversation-compose.ts` | 新增 `activeSessions` Map + startAgentRun 里注册 steer/followUp + onRunComplete 清除 |
| `conversation/service.ts` | postMessage busy 时 steer 而非抛 409；非 busy 时优先 followUp |
| `conversation/service.ts` | ConversationServiceDeps 加 `activeSessions` 参数 |

## 6. 前端变更

| 文件 | 改动 |
|---|---|
| `hooks/useConversation.ts` | 409 处理改为 "queued" 而非 error toast；新增 queuedMessages state |
| `ConversationCanvas.tsx` | 排队消息区域：半透明气泡 + 编辑 + 撤回 + 折叠 |
| `ConversationCanvas.tsx` | 运行中输入框 placeholder "Steer the agent..."，完成 "Send a message..." |

## 7. 验收标准

1. Agent 运行中用户发消息 → 消息出现在排队区域（半透明气泡），不报 409
2. 排队消息可编辑：点击修改 → 保存 → 队列更新
3. 排队消息可撤回：点 ✕ → 从排队区域移除
4. agent 消费排队消息后 → 该消息从排队区域消失，出现在 Timeline
5. 排队区域为空时折叠不占空间
6. Agent 完成后用户发消息 → 触发 followUp，不创建新 session
7. 运行中输入框 placeholder 为 "Steer the agent..."
8. session dispose 后发消息 → 走正常 postMessage → 创建新 session
9. typecheck + test + lint 全绿


## 8. 不做的事

- 不改 harness/framework 的 steer/followUp 机制（已完整）
- 不改 SessionManager 接口
- 不做 followUp 的 UI 区分（followUp 和 prompt 在 UI 上都是"发消息"，只是后端路由不同）
- 不做 steering 消息的后端撤回（harness SteeringQueue 是消费式的，push 后不可撤回；前端撤回是 best-effort）
