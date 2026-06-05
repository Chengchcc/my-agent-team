# M4 Spec — Framework 补齐

> 基于 M3 framework 实现。目标：把 framework 从当前实现补完到架构文档定义的水平。Agent.resume + InterruptSignal + Checkpointer 扩展 + ContextManager + Logger + 内置实现迁移。

---

## 一、设计原则

沿用 M1-M3 不变。M4 不引入新概念——只补齐已设计好的。

- **第一性原理** — Interrupt/resume 来自 human-in-the-loop 的真实需求；ContextManager 来自 context window 上限的物理事实
- **奥卡姆剃刀** — 四大内化能力统一样式：接口 + 默认实现 + `createAgent` 可注入替换。不引入额外抽象
- **状态归调用方** — ContextManager 不改 thread.messages，只产出视图。Checkpointer 存完整版
- **Rule of Three** — 三大内化能力（Checkpointer / ContextManager / Logger）都实现了，Plugin 回归纯扩展点角色

---

## 二、M4 定位

M4 不是新包——是 **`@my-agent-team/framework` 的内部补齐**。零新依赖（只依赖 core）。

M4 之前的 harness-coding 推后到 M5，M4 先把 foundation 做对。

---

## 三、交付范围

### 3.1 补齐 Agent 合约

| 项 | 当前 | 目标 |
|---|---|---|
| `Agent.run()` 返回类型 | `AsyncIterable<Message>` | `AsyncIterable<AgentMessage>` |
| `Agent.resume()` | 无 | `resume(decision: ResumeDecision): AsyncIterable<AgentMessage>` |
| `AgentMessage` | 无 | `Message \| { type: 'interrupted', ... }` |
| `ResumeDecision` | 无 | `{ approved: boolean, message?: string }` |
| 并发保护 | `run()` only | `run()` + `resume()` 都受 `#running` 保护 |

### 3.2 补齐 Checkpointer（中断 + 事件流）

```ts
// packages/framework/src/checkpointer.ts — 新增

class InterruptSignal extends Error {
  constructor(reason: string, meta?: Record<string, unknown>);
}

interface InterruptState {
  pendingTool: { call: ToolUseBlock; reason: string };
  ts: number;
  meta?: Record<string, unknown>;
}

type AgentEvent =
  | { type: 'user_input'; ... }
  | { type: 'model_start'; ... }
  | { type: 'model_end'; ... }
  | { type: 'tool_start'; ... }
  | { type: 'tool_end'; ... }
  | { type: 'interrupt'; ... }
  | { type: 'resume'; ... }
  | { type: 'run_end'; ... };

interface Checkpointer {
  // 已有
  save(threadId: string, messages: readonly Message[]): Promise<void>;
  load(threadId: string): Promise<Message[] | null>;

  // 新增 — interrupt
  saveInterrupt?(threadId: string, state: InterruptState): Promise<void>;
  consumeInterrupt?(threadId: string): Promise<InterruptState | null>;

  // 新增 — event stream
  appendEvent?(threadId: string, event: AgentEvent): Promise<void>;
  readEvents?(threadId: string): AsyncIterable<AgentEvent>;
}
```

### 3.3 补齐 ContextManager

```ts
// packages/framework/src/context-manager.ts — 新文件

interface ContextManagerContext {
  threadId: string;
  signal?: AbortSignal;
  modelInfo?: { id?: string; maxInputTokens?: number };
  systemPrompt?: string;
}

interface ContextManager {
  shape(ctx: ContextManagerContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
}

function pipeContextManagers(...managers: ContextManager[]): ContextManager;
```

**内置实现：**

| 实现 | 文件 | 职责 |
|---|---|---|
| `passthroughContextManager()` | `context-managers/passthrough.ts` | 默认，原样返回 |
| `slidingWindowContextManager({ maxTurns, keepFirst? })` | `context-managers/sliding-window.ts` | 保留最近 N 轮，配对感知 |
| `tokenBudgetContextManager({ maxTokens, tokenizer })` | `context-managers/token-budget.ts` | 按 token 裁剪 |
| `toolResultTruncator({ maxBytesPerResult })` | `context-managers/tool-result-truncator.ts` | 截断超长 tool_result |
| `summarizingContextManager({ triggerAt, keepRecent, summarizer })` | `context-managers/summarizing.ts` | 摘要压缩 |

### 3.4 补齐 Logger

```ts
// packages/framework/src/logger.ts — 新文件

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

interface Logger {
  level: LogLevel;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

function consoleLogger(options?: { level?: LogLevel }): Logger;
```

- 默认 `consoleLogger({ level: 'info' })`。`debug`→`console.debug`，`info`→`console.log`，`warn`→`console.warn`，`error`→`console.error`
- `silent`：所有方法为空操作
- framework 内部调用前检查 `logger.level`：低于当前 level 不执行

### 3.5 补齐内置 Checkpointer

| 实现 | 文件 | 职责 |
|---|---|---|
| `inMemoryCheckpointer()` | `checkpointers/in-memory.ts` | 默认，Map 存储，实现全部 6 方法 |
| `fileCheckpointer({ dir })` | `checkpointers/file-checkpointer.ts` | **升级**：`{path}`→`{dir}`，threadId 分文件 |

### 3.6 迁移现有代码

| 源 | 目标 | 说明 |
|---|---|---|
| `plugins/sliding-window.ts` | `context-managers/sliding-window.ts` | Plugin → ContextManager |
| `plugins/console-logger.ts` | `logger.ts` | Plugin → Logger（`consoleLogger` 工厂） |
| `checkpointers/file-checkpointer.ts` | 重写 | `{path}`→`{dir}`，加 interrupt + event 方法 |

**删除** `packages/framework/src/plugins/` 整个目录——framework 零内置 plugin。consoleLogger 和 slidingWindow 源码保留但迁移到正确位置。

### 3.7 `createAgent` 集成

**AgentConfig 新增字段：**

```ts
interface AgentConfig {
  // ... 已有字段 ...
  contextManager?: ContextManager;   // 默认 passthroughContextManager
  logger?: Logger;                   // 默认 consoleLogger({ level: 'info' })
}
```

**Agent.run() 内部改动：**

1. Loop 中 `shapedMessages = await this.#contextManager.shape(ctx, thread.messages)` 先于 `plugin.beforeModel`
2. 用 `this.#logger.warn(...)` 替换所有 `console.warn`
3. 关键事件调用 `this.#checkpointer?.appendEvent?.(...)`
4. Tool 执行中识别 `InterruptSignal`，走 interrupt 流程而非普通 tool error

**Interrupt 流程：**

```
tool.execute() throws InterruptSignal
  ↓
checkpointer.save(threadId, messages)    // 保存到 tool_use 之前
checkpointer.saveInterrupt(threadId, {   // 保存中断状态
  pendingTool: { call, reason },
  ts: Date.now(),
  meta,
})
checkpointer.appendEvent({ type: 'interrupt', ... })
yield { type: 'interrupted', pendingTool, reason, meta }
return                                     // 退出 generator
```

**Resume 流程：**

```
agent.resume({ approved: true })
  ↓
checkpointer.consumeInterrupt(threadId) → InterruptState
  ↓
messages.push({ role: 'user', content: [{
  type: 'tool_result',
  tool_use_id: call.id,
  content: approved ? (message ?? 'approved') : (message ?? 'denied'),
  is_error: !approved,
}]})
checkpointer.save(threadId, messages)
  ↓
继续 loop...
```

---

## 四、包结构变更

```text
packages/framework/src/
├── create-agent.ts              # 修改：加 resume、ContextManager、Logger、Interrupt 流程
├── create-agent.test.ts         # 修改：补 resume/interrupt/contextManager/logger 测试
├── thread.ts                    # 不变
├── plugin.ts                    # 不变（接口已对）
├── plugin.test.ts               # 不变
├── checkpointer.ts              # 修改：加 InterruptSignal、InterruptState、AgentEvent、4 新方法
├── logger.ts                    # 新建：LogLevel、Logger、consoleLogger
├── logger.test.ts               # 新建
├── context-manager.ts           # 新建：ContextManager、ContextManagerContext、pipeContextManagers
├── context-manager.test.ts      # 新建
├── context-managers/
│   ├── passthrough.ts           # 新建
│   ├── passthrough.test.ts
│   ├── sliding-window.ts        # 迁移自 plugins/sliding-window.ts（重写）
│   ├── sliding-window.test.ts   # 迁移
│   ├── token-budget.ts          # 新建
│   ├── token-budget.test.ts
│   ├── tool-result-truncator.ts # 新建
│   ├── tool-result-truncator.test.ts
│   ├── summarizing.ts           # 新建
│   └── summarizing.test.ts
├── checkpointers/
│   ├── in-memory.ts             # 新建
│   ├── in-memory.test.ts
│   ├── file-checkpointer.ts     # 重写（dir layout）
│   └── file-checkpointer.test.ts
├── plugins/                     # 删除整个目录
├── index.ts                     # 修改：导出新类型
```

---

## 五、不做的

- ❌ 不做 `redisCheckpointer`（独立适配包，M5+）
- ❌ 不做 `summarizingContextManager` 的内置 summarizer（用户提供函数，framework 只提供框架）
- ❌ 不修改 M1/M2 包
- ❌ 不做 Backend（M5）
- ❌ 不做 Harness（M5）

---

## 六、测试要求

### 6.1 Checkpointer 测试

| 文件 | 场景 |
|---|---|
| `in-memory.test.ts` | save/load 往返、saveInterrupt/consumeInterrupt 往返、appendEvent/readEvents 往返、load null |
| `file-checkpointer.test.ts` | 同上 + dir layout 正确、atomic write、thread 隔离 |

### 6.2 Logger 测试

| 文件 | 场景 |
|---|---|
| `logger.test.ts` | level=info 时 debug 不输出、level=warn 时 info/debug 不输出、silent 全不输出、各方法输出到 console |

### 6.3 ContextManager 测试

| 文件 | 场景 |
|---|---|
| `passthrough.test.ts` | 返回新数组（不共享引用）、不 mutate 入参 |
| `sliding-window.test.ts` | 保留 N 轮、keepFirst、配对感知（不产生孤儿 tool_use）、不足时全保留、不 mutate 入参 |
| `token-budget.test.ts` | 按 token 从尾累加、超限截断、保留 system |
| `tool-result-truncator.test.ts` | 超长截断+标记、短的不变、配对不变 |
| `pipe.test.ts` | 两个 CM 管道顺序、前一个输出=后一个输入 |

### 6.4 create-agent 测试（补充）

| 场景 | 断言 |
|---|---|
| resume approved | 补充 tool_result → model 收到 → 继续完成 |
| resume denied | tool_result is_error=true → model 收到 |
| interrupt 抛 InterruptSignal | yield `{ type: 'interrupted' }`，messages 在 tool_use 前 save |
| interrupt 无 checkpointer 支持 | throw（降级为普通错误） |
| contextManager 注入 | shape 在 plugin.beforeModel 之前被调 |
| logger 注入 | 日志经 logger.warn 非 console.warn |
| appendEvent | tool_start/tool_end/interrupt 事件被记录 |

### 6.5 回归测试

M1/M2/M3 已有测试全部继续通过（无退化）。

---

## 七、CI Gate

沿用已有工具链。通过标准同 M1-M3。

---

## 八、验收清单

- [ ] `bun run format && bun run lint && bun run typecheck && bun run test && bun run build` 全绿
- [ ] `Agent.resume(decision)` 实现且测试覆盖
- [ ] `InterruptSignal` 实现且 tool 抛它走 interrupt 流程
- [ ] Checkpointer 接口 6 方法全部定义，`inMemoryCheckpointer` + `fileCheckpointer` 全部实现
- [ ] ContextManager 接口 + 5 内置实现 + `pipeContextManagers` 全部可用
- [ ] Logger 接口 + `consoleLogger` + level 过滤 全部可用
- [ ] `plugins/` 目录已删除；slidingWindow 已迁移到 `context-managers/`；consoleLogger 已迁移到 `logger.ts`
- [ ] `createAgent` 接受 `contextManager` 和 `logger`，默认值生效
- [ ] M1/M2/M3 已有测试全部通过

---

**Spec 结束。**
