# Spec P-8: Frontend Adapter 重构 + Command 体系统一

## TL;DR

把 `frontend.tui` 从"旧 Agent/TUI 兼容壳"重构成**当前 kernel 架构下的正式 frontend adapter**，同时将 `frontend.lark` 纳入同一套 transcript projector + session-client 基础设施。把 slash command 从"TUI 本地交互细节"提升为**跨 frontend 的统一应用层能力**，引入 `group` 机制。

五轨顺序执行：

- **A**: controlplane snapshot RPC + transcript projector + session-client + 两前端同改
- **B**: command registry/parser 落地，`/clear` `/compact` `/help` 等迁出 TUI 私有实现
- **C**: hotkey dispatcher 统一，input 仲裁
- **D**: 删除 fake `Agent`/`SessionStore`/`ContextManager` 兼容中心 + types.ts 依赖清零

---

## Why now

1. `frontend.tui` 围绕旧 `Agent` façade 组织 — `KernelAgentFacade`/`KernelSessionStoreFacade` 是 fake 实现（`getMessages(): []`、`forceCompact(): async () => {}`）
2. session 恢复链路依赖 `contextManager.addMessage()` — no-op stub，历史消息无法恢复
3. tool 消息实时/历史各一套解析逻辑，无统一 transcript projector
4. commands 是 TUI 私有，Lark Bot 无法复用 `/help` `/compact` 等能力
5. hotkeys 分散在多个 `useInput()` hook 中，相互抢键
6. command 入口分裂 — TUI 输入框 `/xxx` 和 Lark Bot slash 消息各自解析
7. `frontend.tui/**` 仍 import `src/types.ts`（`Message`、`ToolCall`）

---

## Track A: Snapshot + Transcript Projector + Session-Client

### A.1 controlplane 新增/统一 RPC

| RPC | 说明 |
|-----|------|
| `session.attach` | 返回 snapshot: `{ ok, sessionId, frontendId, snapshot: HistoryRecordV1[] }` |
| `session.resume` | 返回 snapshot: `{ ok, sessionId, session, snapshot: HistoryRecordV1[] }` |
| `session.clear` | 清除 session 历史: `{ ok, sessionId }` |
| `session.compact` | 触发 compact: `{ ok, sessionId }`（compact 逻辑由 memory ext 实现） |
| `session.stats` | 返回 token 统计: `{ input, output, turnCount }` |
| `tool.list` | 返回 tool 列表: `{ tools: Array<{ name, description, parameters }> }` |

### A.2 Snapshot 契约

`session.attach` / `session.resume` 返回的 `snapshot` 字段是 `HistoryRecordV1[]`（已在 `application/contracts/` 中定义，session extension NDJSON 持久化使用）。前端不再通过 `contextManager.addMessage()` 回灌消息，而是直接喂给 transcript projector。

### A.3 session-client

新增 `frontend.tui/session-client.ts`（Lark 也可用）：

```ts
interface SessionClient {
  listSessions(): Promise<SessionSummary[]>
  attachSession(frontendId: string, sessionId?: string): Promise<{ sessionId, snapshot: HistoryRecordV1[] }>
  resumeSession(frontendId: string, currentSessionId: string, targetSessionId: string): Promise<{ sessionId, snapshot: HistoryRecordV1[] }>
  createSession(frontendId: string, title?: string): Promise<{ sessionId }>
  sendInput(sessionId: string, frontendId: string, text: string): Promise<void>
  cancelInput(sessionId: string, reason?: string): Promise<void>
  clearSession(sessionId: string): Promise<void>
  compactSession(sessionId: string): Promise<void>
  subscribeEvents(frontendId: string, sessionId: string, cb: (event: DataPlaneEvent) => void): () => void
}
```

### A.4 Transcript Projector

建立统一内部事件模型 `TranscriptEvent`：

| 事件 | 触发源 | 说明 |
|------|-------|------|
| `session_snapshot_loaded` | session.attach/resume 返回 | 历史批量加载 |
| `user_message` | input.send | 用户输入 |
| `turn_started` | turn-runner | turn 开始 |
| `assistant_text_delta` | provider LLM delta | 每次 delta |
| `assistant_text_final` | provider LLM 流结束 | 每次 LLM 响应结束时发 |
| `tool_call_started` | turn-runner tool.start | tool 开始执行 |
| `tool_call_finished` | turn-runner tool.end | tool 执行完毕 |
| `turn_completed` | turn-runner | turn 结束 |
| `turn_failed` | turn-runner | turn 失败 |
| `system_notice` | 各类系统事件 | 通知/警告 |
| `permission_requested` | permission ext | 权限请求 |
| `user_question_requested` | ask-user-question tool | 用户问卷请求 |

数据流：

```
dataplane events + HistoryRecordV1[]
  → transcript projector
    → TranscriptEvent[]（跨 frontend 通用）
      → TUI renderer → FinalItem / LiveAssistant / CommittedBlock（TUI view model）
      → Lark renderer → 卡片 / 文本消息（Lark view model）
```

**不变量**：
- projector 不负责 markdown 解析（committer 保留在 TUI 层，Lark 不需要）
- `ToolCallViewModel` 的 `result` 保持原始类型（`unknown`），view 层按 tool name 选择 renderer
- `assistant_text_final` 在每次 LLM 流式响应结束时发出（不论后面是否还有 tool call 或下一轮迭代）

### A.5 两前端同改

Phase A 同时改造 `frontend.tui` 和 `frontend.lark`，接入共享基础：
- session-client（统一 kernel 通信）
- transcript projector（统一事件投影）

Lark streaming：A 方案 + 限流 — turn 内 N 秒批量 `updateMessage()` 刷新卡片，细节后续优化。

---

## Track B: Command 体系统一

### B.1 Command 归属

新增 `src/application/commands/`：

```
src/application/commands/
  types.ts              — CommandDefinition, CommandGroup, ParsedCommand, CommandExecutionContext
  command-groups.ts     — group 定义（core/session/context/tooling/ui/workflow/debug/admin）
  command-registry.ts   — 注册、查询、alias 解析、frontend 过滤
  parse-command.ts      — 统一 parser（slash 检测、name/args/argv 切分）
  builtin/
    clear.ts
    compact.ts
    help.ts
    cost.ts
    tools.ts
    daemon.ts
    exit.ts
```

不做独立 extension — command 是纯应用层逻辑（类似 `define-tool.ts`），无生命周期、不 emit 事件、不依赖 bus。

### B.2 CommandDefinition

```ts
interface CommandDefinition {
  name: string
  description: string
  group: string
  aliases?: string[]
  usage?: string
  examples?: string[]
  availability?: Array<'tui' | 'lark-bot' | 'webui' | 'api'>
  visible?: boolean
  execute: (ctx: CommandExecutionContext) => Promise<CommandResult> | CommandResult
}
```

### B.3 CommandGroup

```ts
interface CommandGroup {
  key: string
  title: string
  order?: number
  description?: string
}
```

预设 group: `core`, `session`, `context`, `tooling`, `ui`, `workflow`, `debug`, `admin`

### B.4 CommandExecutionContext

```ts
interface CommandExecutionContext {
  frontend: 'tui' | 'lark-bot' | 'webui'
  sessionId?: string
  userInputRaw: string
  kernel: {
    rpc(method: string, params?: Record<string, unknown>): Promise<unknown>
  }
  reply: {
    text(message: string): Promise<void> | void
    markdown?(message: string): Promise<void> | void
    notice?(message: string): Promise<void> | void
  }
  ui?: {
    openSessionPicker?(): void
    clearTranscript?(): void
  }
}
```

Command 通过 `kernel.rpc()` 驱动所有副作用。不直接访问 bus 或 extensions。

### B.5 CommandRegistry

```ts
interface CommandRegistry {
  register(cmd: CommandDefinition): void
  unregister(name: string): void
  get(name: string): CommandDefinition | undefined
  list(filter?: { frontend?: string; group?: string }): CommandDefinition[]
  resolveAlias(name: string): string | undefined
  parse(raw: string): ParsedCommand | null
}
```

### B.6 ParsedCommand

```ts
interface ParsedCommand {
  name: string
  args: string        // /foo arg1 arg2 → "arg1 arg2"
  argv: string[]      // /foo arg1 arg2 → ["arg1", "arg2"]
  raw: string         // "/foo arg1 arg2"
}
```

### B.7 TUI 职责

- command picker (autocomplete)
- grouped help 展示
- 输入阶段高亮
- 最终以统一 parser/registry 为准

### B.8 Lark Bot 职责

- 收到消息以 `/` 开头 → 走统一 parser
- 命中 → 执行 command
- 未命中 → 返回 grouped suggestion
- 非 slash → 正常 agent turn

### B.9 Skill 名称

Skill 名称不作为 command 进入 registry。保留在 input 层作为 autocomplete 快捷方式（类似 @file 补全），最终文本发给 LLM。

### B.10 Command 副作用路径

所有 command 通过 `kernel.rpc()` 驱动副作用。需要新增的 RPC：

| RPC | 用途 |
|-----|------|
| `session.clear` | `/clear` |
| `session.compact` | `/compact` |
| `session.stats` | `/cost` |
| `tool.list` | `/tools` |
| `system.health` | `/daemon`（已有）|
| `system.shutdown` | `/exit`（已有）|

RPC handler 负责 emit 事件 — command 本身不碰 bus。

---

## Track C: Hotkey 统一仲裁

### C.1 KeyDispatcher

建立全局 `InputRouter` / `KeyDispatcher`，使用**显式注册 + 栈**模式：

- 组件激活时 push 到栈顶
- 组件 dismiss 时 pop
- 当前栈顶吃键

### C.2 优先级（动态，非静态）

栈顶 = 当前最高优先级，不预定义静态顺序。典型栈形态：

```
permission prompt (顶部 — 最近激活)
  → ask-user-question prompt
    → session picker
      → slash command picker
        → @file picker
          → streaming mode
            → normal editor (底部 — 默认层)
```

### C.3 统一键语义

所有 overlay/picker/streaming/normal 层共享统一 `Esc / Enter / Tab / Up / Down` 语义，由 KeyDispatcher 仲裁，不再有多个 `useInput` hook 抢键。

---

## Track D: 删除旧兼容层

### D.1 删除项

| 组件 | 位置 | 原因 |
|------|------|------|
| `KernelAgentFacade` (implements `Agent`) | `frontend.tui/index.ts` | 替换为 session-client |
| `KernelSessionStoreFacade` (implements `SessionStore`) | `frontend.tui/index.ts` | 替换为 session-client |
| `Agent` 接口 | `frontend.tui/types.ts` | 不再需要 |
| `AgentContextManager` 接口 | `frontend.tui/types.ts` | 不再需要 |
| `SessionStore` 接口 | `frontend.tui/types.ts` | 不再需要 |
| `AgentEvent` 类型（旧 16 变体）| `frontend.tui/types.ts` | 替换为 TranscriptEvent |
| `CommandHandlerContext` | `frontend.tui/tui-types.ts` | 替换为 CommandExecutionContext |
| `TUIAdapter.asAgent()` | `frontend.tui/index.ts` | 删除 |
| `TUIAdapter.asSessionStore()` | `frontend.tui/index.ts` | 删除 |
| `Message` from `src/types.ts` | `frontend.tui/**` | 替换为 HistoryRecordV1 |
| `ToolCall` from `src/types.ts` | `frontend.tui/**` | 替换为 ToolCallViewModel |

### D.2 保留但瘦身

| 组件 | 瘦身后 |
|------|--------|
| `TUIAdapter` (implements `FrontendHandle`) | 只保留 `sendRpc/subscribeEvents/start/stop` |
| `EventBridge` | 保留（transport push → async iterable pull 桥梁） |
| `committer.ts` | 保留在 TUI 层，markdown 块增量解析 |

### D.3 `lark/types.ts` 旧依赖修复

`lark/types.ts` 第 2 行 `import { Session } from '../../../types'` → `import { Session } from '../../../domain/session'`。

### D.4 验收

- `frontend.tui/**` 和 `frontend.lark/**` 不再 import `src/types.ts`
- `grep -r "from.*types" src/extensions/frontend.tui/` 零结果
- `grep -r "from.*types" src/extensions/frontend.lark/` 零结果
- `KernelAgentFacade` / `KernelSessionStoreFacade` / `asAgent()` / `asSessionStore()` 不存在

---

## 不变量

| 不变量 | 内容 |
|--------|------|
| **INV-Projector-1** | Transcript projector 是唯一 transcript item 产出点；frontend 不得自行拼装 transcript |
| **INV-Projector-2** | projector 不包含 markdown 解析；markdown 解析是 frontend 渲染层职责 |
| **INV-Session-1** | 所有 kernel 通信通过 session-client；frontend 不得直接调 transport.sendRpc |
| **INV-Session-2** | session 恢复通过 snapshot + projector，不走 contextManager.addMessage |
| **INV-Command-1** | command 副作用唯一出口是 `kernel.rpc()`；command 不得直接访问 bus/extensions |
| **INV-Command-2** | command registry 是唯一 command 定义源；frontend 不得维护独立 command 列表 |
| **INV-Hotkey-1** | KeyDispatcher 是唯一按键路由点；组件不得独立 useInput 拦截全局快捷键 |
| **INV-Frontend-1** | `frontend.tui/**` 和 `frontend.lark/**` 不 import `src/types.ts` |

---

## Commit Plan

| # | Track | Commit |
|---|-------|--------|
| 1 | A | `feat(p8): extend controlplane RPC — session.clear/compact/stats, tool.list, snapshot returns` |
| 2 | A | `feat(p8): add session-client — unified kernel communication layer` |
| 3 | A | `feat(p8): add transcript projector — unified event model + projector` |
| 4 | A | `refactor(p8): rewire TUI session attach/resume to snapshot + projector` |
| 5 | A | `refactor(p8): rewire Lark session attach to snapshot + session-client` |
| 6 | A | `feat(p8): add Lark streaming card update path via projector` |
| 7 | B | `feat(p8): add application/commands — types, groups, registry, parser` |
| 8 | B | `feat(p8): migrate /clear /compact /help /cost /tools /daemon /exit to commands` |
| 9 | B | `refactor(p8): wire TUI slash input to unified command parser` |
| 10 | B | `feat(p8): wire Lark Bot slash messages to unified command parser` |
| 11 | C | `feat(p8): add KeyDispatcher with push/pop stack` |
| 12 | C | `refactor(p8): migrate all useInput hooks to KeyDispatcher` |
| 13 | D | `chore(p8): delete KernelAgentFacade, KernelSessionStoreFacade, Agent, SessionStore, AgentContextManager` |
| 14 | D | `chore(p8): remove types.ts imports from frontend.tui and frontend.lark` |

---

## 验证

1. `bun test` 全绿
2. session picker 选中历史 session 后，可正确恢复文本 + tool 结果
3. 实时 tool call 与历史 tool call 展示一致
4. TUI 输入 `/help` 命中统一 command registry
5. Lark Bot 收到 `/help` 也命中同一 registry
6. help/picker 按 group 展示
7. overlay / picker / streaming 按键不冲突
8. `grep -rn "from.*types" src/extensions/frontend.tui/` → 0 results
9. `grep -rn "from.*types" src/extensions/frontend.lark/` → 0 results
10. `KernelAgentFacade` / `KernelSessionStoreFacade` / `asAgent()` / `asSessionStore()` 不存在
