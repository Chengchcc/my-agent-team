# Checkpointer 架构设计

## 定位

Checkpointer 是 framework 的**内化能力**，承担 agent 执行状态的持久化与可恢复性。它不是可选的 plugin 扩展 —— 它是 framework 的核心组件，永远存在，只是实现可替换（内存 / 文件 / Redis / 数据库）。

它解决三个第一性问题：

1. **状态持久化** —— 进程崩溃后，下次启动能从最近的 tool 边界续跑
2. **可中断执行** —— human-in-the-loop 场景下，agent loop 能暂停、退出进程、等待外部决策、新进程恢复
3. **执行流可观测** —— UX 层可以读取历史事件流，做时间轴回放

---

## 模块边界

| 模块 | 职责 | 归属 |
|---|---|---|
| `Checkpointer` | 接口定义 + 内置 InMemory 实现 | framework |
| `InterruptSignal` | Tool 抛出的中断信号 | framework |
| `AgentEvent` | 事件流的类型定义 | framework |
| `fileCheckpointer` | 文件实现（JSON state + JSONL events） | framework |
| `redisCheckpointer` 等 | 其他持久层实现 | 独立适配包（M5+） |

依赖方向：framework → core。Checkpointer 实现不依赖 adapter / tools / harness。

---

## 接口设计

### 核心契约

```ts
interface Checkpointer {
  // ============== 必需能力 ==============

  /** 保存 thread 当前完整 messages */
  save(threadId: string, messages: readonly Message[]): Promise<void>;

  /** 加载 thread 历史 messages，无则返回 null */
  load(threadId: string): Promise<Message[] | null>;

  // ============== 可选能力：Interrupt ==============

  /** 保存中断状态（用于 human-in-the-loop） */
  saveInterrupt?(threadId: string, state: InterruptState): Promise<void>;

  /** 读取并清除中断状态（恢复时用） */
  consumeInterrupt?(threadId: string): Promise<InterruptState | null>;

  // ============== 可选能力：Event Stream ==============

  /** 追加一条执行事件（用于 UX 回放、审计） */
  appendEvent?(threadId: string, event: AgentEvent): Promise<void>;

  /** 读取完整事件流 */
  readEvents?(threadId: string): AsyncIterable<AgentEvent>;
}
```

### 配套类型

```ts
interface InterruptState {
  /** 中断时挂起的 tool call —— 等待外部决策 */
  pendingTool: { call: ToolUseBlock; reason: string };
  /** 中断时间戳 */
  ts: number;
  /** 附加上下文（由 Tool 提供给前端展示用） */
  meta?: Record<string, unknown>;
}

type AgentEvent =
  | { type: 'user_input'; content: string; ts: number }
  | { type: 'model_start'; messageCount: number; ts: number }
  | { type: 'model_end'; blocks: ContentBlock[]; usage?: { input: number; output: number }; ts: number }
  | { type: 'tool_start'; call: ToolUseBlock; ts: number }
  | { type: 'tool_end'; result: ToolResultBlock; durationMs: number; ts: number }
  | { type: 'interrupt'; pendingTool: ToolUseBlock; reason: string; ts: number }
  | { type: 'resume'; ts: number }
  | { type: 'run_end'; reason: 'complete' | 'aborted' | 'maxSteps'; ts: number };

class InterruptSignal extends Error {
  constructor(
    public readonly reason: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(`Interrupted: ${reason}`);
    this.name = 'InterruptSignal';
  }
}
```

---

## 能力分层（Capability Detection）

Checkpointer 接口分**必需 / 可选**两层，framework 用方法存在性判断能力：

| 能力 | 方法 | 不实现的后果 |
|---|---|---|
| 基础持久化 | `save` / `load` | **强制** —— 不实现 = 不是 Checkpointer |
| Human-in-the-loop | `saveInterrupt` / `consumeInterrupt` | Tool 抛 `InterruptSignal` 时 throw |
| UX 回放 / 审计 | `appendEvent` / `readEvents` | 不记录事件流，但 agent 正常运行 |

Framework 在调用前检查：

```ts
if (checkpointer.saveInterrupt) {
  await checkpointer.saveInterrupt(threadId, interruptState);
} else {
  throw new Error(
    'Tool requested interrupt but checkpointer does not support it. ' +
    'Use fileCheckpointer or implement saveInterrupt/consumeInterrupt.'
  );
}
```

---

## 内置实现

### `inMemoryCheckpointer` （默认）

```ts
export const inMemoryCheckpointer = (): Checkpointer => {
  const messages = new Map<string, Message[]>();
  const interrupts = new Map<string, InterruptState>();
  const events = new Map<string, AgentEvent[]>();

  return {
    async save(id, msgs) { messages.set(id, structuredClone([...msgs])); },
    async load(id) { return messages.get(id) ? structuredClone(messages.get(id)!) : null; },

    async saveInterrupt(id, state) { interrupts.set(id, state); },
    async consumeInterrupt(id) {
      const s = interrupts.get(id);
      interrupts.delete(id);
      return s ?? null;
    },

    async appendEvent(id, event) {
      if (!events.has(id)) events.set(id, []);
      events.get(id)!.push(event);
    },
    async *readEvents(id) {
      yield* events.get(id) ?? [];
    },
  };
};
```

- `createAgent` 不传 checkpointer 时默认用它
- 进程退出 = 状态丢失，但接口完整，**保证 framework 行为统一**
- 适合：单进程一次性任务、测试

### `fileCheckpointer`

```ts
fileCheckpointer({ dir }): Checkpointer
```

文件布局：

```
${dir}/
├── ${threadId}.state.json        # messages 快照
├── ${threadId}.interrupt.json    # 当前 interrupt（可能不存在）
└── ${threadId}.events.jsonl      # 事件追加流
```

- `save` / `saveInterrupt`：原子写（`Bun.write(tmp, ...)` + `Bun.rename(tmp, target)`），防止写一半崩溃文件损坏
- `load` / `consumeInterrupt`：读对应 json 文件
- `appendEvent`：直接 append 一行 JSONL（丢一行事件可接受，不需要原子写）

适合：CLI、单机服务、本地开发。

### `redisCheckpointer`（M5+，独立包）

- `save` → `SET state:${id}`
- `appendEvent` → `XADD events:${id} *`（Redis Stream）
- `saveInterrupt` → `SET interrupt:${id}`

适合：多进程 Web 服务、分布式 worker。

---

## Framework 集成点

### 时机契约（强制，写死，不可配置）

| Framework 调用 | 时机 | 目的 |
|---|---|---|
| `checkpointer.load(threadId)` | `createAgent` 后第一次 `run` 前 | 恢复历史 messages |
| `checkpointer.save(threadId, messages)` | 每次 tool 执行完成、tool_result 已 push 之后 | 状态落点必须是合法 API 输入 |
| `checkpointer.save(threadId, messages)` | 每次 model 返回纯文本（无 tool_use）loop 结束之后 | 收尾保存 |
| `checkpointer.saveInterrupt(...)` | 捕获 `InterruptSignal` 之后、退出 generator 之前 | 必须在 save 之后调，保证 interrupt 引用的 messages 已落盘 |
| `checkpointer.consumeInterrupt(...)` | `agent.resume()` 调用时 | 读出 pending tool 信息 |
| `checkpointer.appendEvent?(...)` | 每个关键事件发生时（model_start / tool_end / ...） | 可选记录 |

**关键纪律**：save 时机只在 **messages 处于合法 API 输入态** 时触发。即 messages 末尾必须是：

- `user(text)` —— 首次输入
- `assistant(text only)` —— 完成的轮次
- `user(tool_result)` —— tool 执行完成

**Interrupt 时的特殊处理**：tool 抛 `InterruptSignal` 时，messages 末尾是 `assistant(tool_use)`——严格说是非法 API 状态。但中断时**不做回退**——保存当前完整 messages。`agent.resume()` 时 framework 会先补上 `tool_result`，让 messages 恢复合法后再继续 loop。这样不丢失 model 已产出的 tool_use，也避免了重新调 LLM。

### Agent API 暴露

```ts
interface Agent {
  readonly thread: Thread;
  run(input: string, options?: RunOptions): AsyncIterable<AgentMessage>;
  /** 从 interrupt 恢复。ResumeCommand 告知 framework 如何处理挂起的 tool */
  resume(command: ResumeCommand, options?: RunOptions): AsyncIterable<AgentMessage>;
  fork(messages?: Message[], id?: string): Agent;
}

/** 比 LangChain Command 简单——没有 goto/update */
interface ResumeCommand {
  /** 填入 tool_result.content */
  content: string;
  /** 用户拒绝时设 true */
  isError?: boolean;
}

type AgentMessage =
  | Message
  | { type: 'interrupted'; pendingTool: ToolUseBlock; reason: string; meta?: unknown };
```

---

## Interrupt & Resume 完整流程

### 第一次执行 → 中断

```
User code:
  agent.run("clean up node_modules")

Framework:
  ↓ checkpointer.appendEvent({ type: 'user_input', ... })
  ↓ thread.messages.push(user_msg)
  ↓ checkpointer.save(threadId, messages)
  ↓ loop:
    ↓ model.stream(...) → assistant with tool_use
    ↓ thread.messages.push(assistant_msg)
    ↓ checkpointer.appendEvent({ type: 'model_end', ... })
    ↓ for each tool_use:
      ↓ tool.execute(input) ──→ throws InterruptSignal('permission_required')
      ↓ checkpointer.save(threadId, messages)       # 保存到 tool_use 之前的安全态
      ↓ checkpointer.saveInterrupt(threadId, {
           pendingTool: { call, reason: 'permission_required' },
           ts: Date.now(),
        })
      ↓ checkpointer.appendEvent({ type: 'interrupt', ... })
      ↓ yield { type: 'interrupted', pendingTool, reason }
      ↓ return  # generator 退出

User code:
  收到 { type: 'interrupted' }
  process.exit(0)
```

### 新进程 → 恢复

```
User code:
  const agent = createAgent({
    model, tools,
    threadId: 'session-1',
    checkpointer: fileCheckpointer({ dir: './state' }),
  });
  # createAgent 内部：load → messages 恢复

  const decision = await getUserDecision();
  for await (const msg of agent.resume(decision)) { ... }

Framework (agent.resume):
  ↓ checkpointer.consumeInterrupt('session-1') → { pendingTool: { call, reason } }
  ↓ checkpointer.appendEvent({ type: 'resume', ts: ... })
  ↓ thread.messages.push({
       role: 'user',
       content: [{
         type: 'tool_result',
         tool_use_id: call.id,
         content: decision.approved
           ? (decision.message ?? 'approved')
           : (decision.message ?? 'denied by user'),
         is_error: !decision.approved,
       }],
    })
  ↓ checkpointer.save(threadId, messages)
  ↓ 继续进入 loop，调 model.stream()...
```

---

## Tool 端：InterruptSignal 用法

Tool 是中断的发起方，由 Tool 决定何时需要人介入：

```ts
import { InterruptSignal } from '@my-agent/framework';

export const bashTool: Tool = {
  name: 'bash',
  description: 'Run a shell command',
  inputSchema: { /* ... */ },

  async execute(input, signal) {
    const cmd = (input as { command: string }).command;

    if (isDangerous(cmd)) {
      throw new InterruptSignal('permission_required', {
        command: cmd,
        risk: 'destructive',
        prompt: `Allow running: ${cmd}?`,
      });
    }

    return runShell(cmd, signal);
  },
};
```

**约定**：

- `InterruptSignal` 是 framework 导出的特殊错误类，framework 识别它并走 interrupt 流程。其他错误正常 push `is_error: true` 的 tool_result
- `meta` 字段由 Tool 自由定义，**透传到 UX 层**给前端做权限询问 UI
- Tool 不知道有没有 checkpointer 支持 interrupt —— 它只管抛；framework 检查能力，不支持时 throw 降级

---

## 与 Plugin 的协作边界

Checkpointer **不是** plugin —— 它是 framework 内化。但 plugin 仍可观察事件：

| 场景 | 用 Checkpointer 还是 Plugin |
|---|---|
| 持久化 messages 用于崩溃恢复 | **Checkpointer**（framework 自动调） |
| 持久化事件流给 UX 回放 | **Checkpointer**（`appendEvent`，framework 自动调） |
| 把每次 tool 调用上报到 metrics 系统 | **Plugin**（observer 模式） |
| 调 LLM 前裁剪 messages | **Plugin**（`beforeModel`） |
| 调 tool 前请求权限 | **Tool 抛 InterruptSignal**（不是 plugin） |

**核心区分**：

- **改变 agent 控制流**（暂停 / 恢复 / 状态持久化）→ Checkpointer
- **观察或 transform 数据**（log / metrics / 裁剪）→ Plugin

Permission 这类需求**从 plugin 中迁出** —— 它本质上是控制流操作（暂停 loop、等待外部输入、恢复），不是数据 transform。
