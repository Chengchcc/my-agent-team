# Plugin 是什么

## 一句话定义

**Plugin 是一组事件钩子的封装，让外部代码在 agent 执行的关键时刻插入逻辑，而不需要修改 framework 或 agent 本身。**

—— 它是 framework 提供的**唯一扩展点**。

---

## 从第一性原理推导：为什么需要 Plugin

L2 `run()` 是一个 async generator：

```
push user message
  loop:
    call model.stream()
    push assistant message
    for each tool_use:
      execute tool
      push tool_result
    if no tool_use: break
```

这是一条**线性流水线**。但真实场景里，你会想在流水线的**特定节点**插入横切逻辑：

| 场景 | 想在哪插？ |
|---|---|
| PII 脱敏/注入元信息 | 调 model 之前 |
| 调试日志 | 每一步之后 |
| 调 tool 前请求权限 | tool 执行之前 |
| 统计 token 用量 | model 返回之后 |

> **注意：** 上下文裁剪和落盘持久化已分别迁移到 ContextManager 和 Checkpointer，不再通过 plugin 实现。

**没有 plugin 的话**，这些逻辑只有 3 个去处：

1. **改 L2 `run()` 源码** —— 框架不可扩展，每加一个需求改一次源码
2. **包装 model / tool** —— 能解决一部分（model 包一层裁剪 messages），但跨步骤的逻辑（如"tool 执行后落盘整个 thread"）包不住，因为单个 tool 看不到整个 messages
3. **调用方在外面循环** —— 那等于放弃了 framework，回到手写 L2

所以 plugin 的存在性来自**第一性事实**：**有些扩展逻辑必须看到 agent 内部的执行节点，且必须能跨多个节点**。这是包装函数解决不了的。

---

## Plugin 不是什么

容易和 plugin 混淆的 4 个概念，必须先撇清：

| 概念 | 区别 |
|---|---|
| **Middleware** | 洋葱模型，有 `next()`，调用方要主动决定何时让流程继续。Plugin 没有 next，框架自动推进 |
| **Decorator / Wrapper** | 包装单个对象（一个 model、一个 tool）。Plugin 看的是 agent 整体执行流 |
| **Tool** | Tool 是 LLM 主动调的能力。Plugin 是 framework 在固定时机被动调的钩子 |
| **Event Listener** | 事件监听只能"知道发生了"，不能改流程。Plugin 的 `before*` 钩子可以 transform messages、skip tool |

---

## Plugin 的能力边界

按 `02-framework.md` 的设计，plugin 能做的事**仅限以下 4 个时刻**：

```
beforeModel  → 调 LLM 之前，可改 messages
afterModel   → LLM 返回后，纯观察
beforeTool   → 执行 tool 之前，可改 input、可 skip
afterTool    → tool 完成后，纯观察
```

**plugin 不能做的事**（这是设计纪律，不是技术限制）：

- 不能拿到 `model` 对象本身（不能 token 计数？自己引 tiktoken）
- 不能拿到 `tool` 列表（不能动态加 tool？那是 framework 的事）
- 不能 emit 自定义事件给其他 plugin（要通信？合成一个 plugin）
- 不能阻止 agent loop 退出（要强制再跑一轮？这是 agent 行为，不是钩子的事）
- 不能持有跨 agent 的全局状态（要全局状态？plugin 实例自己 closure 里存）

---

## Plugin 的两类用途

按返回值类型，plugin 钩子天然分两类：

### 1. Transformer（before*）—— 改变数据流

```ts
beforeModel(ctx, messages) → 新的 messages
beforeTool(ctx, call, messages) → { skip?, input?, result? }
```

- `redactor` —— 调 LLM 前打码 PII
- `injectMetadata` —— 给每条 user message 拼接当前时间/项目信息

> **注意：** 上下文裁剪（原 `slidingWindow` plugin）已迁移到 ContextManager。plugin 不负责空间塑形，只做内容修饰。

**返回值有语义**，framework 会用它。

### 2. Observer（after*）—— 副作用收集

```ts
afterModel(ctx, messages) → void
afterTool(ctx, call, result, messages) → void
```

- `metricsPlugin` —— 上报 token 用量到监控系统

> **注意：** 打日志是 framework 内化能力（`console.log`/`console.warn`），落盘是 Checkpointer 内化能力，上下文裁剪是 ContextManager 内化能力。三者都不是 plugin。

**返回值被忽略**。失败应被吞掉不影响主流程。

---

## Plugin 在四层架构里的位置

```
L4 Harness         ← 选用一组 plugin 组装成产品（如 coding agent 选 redactor + permissions）
   ↓
L3 Framework       ← 定义 Plugin 接口。插件全由用户/harness 提供，framework 零内置 plugin
   ↓
L2 Runtime         ← 不知道 plugin 存在，只跑 run() 循环
   ↓
L1 Protocols       ← 不知道 plugin 存在
```

**关键**：

- **L2 不感知 plugin** —— L2 `run()` 永远是裸 async generator，纯净。Plugin 是 L3 在调 L2 之前/之后插入的
- **L3 定义协议 + 提供通用 plugin** —— 通用 = 领域无关。`slidingWindow` 任何场景都需要，所以归 L3
- **L4 编排具体 plugin 组合** —— `permissionPlugin` 假设了 CLI 交互，归 harness

---

## Plugin vs 其他扩展方式的取舍

为什么不用其他方式？

| 方案 | 为什么不选 |
|---|---|
| 改 `run()` 源码 | 不可复用，每个需求一个 fork |
| 包装 `model` | 只能改 messages，看不到 tool 执行结果 |
| 包装 `tool` | 只能改单个 tool 行为，看不到 model 调用 |
| 事件总线 EventBus | 多了一个心智模型；且事件无法 transform 数据 |
| Middleware with `next()` | 多了一层调用栈控制；调用方要懂洋葱模型；before/after 已够用 |
| Subclass `Agent` | OOP 继承爆炸；多个扩展无法组合 |
| Plugin（当前方案） | 唯一同时满足：跨步骤、可组合、可 transform、心智模型最小 |

---

## 一个判断 plugin 是否设计对的 checklist

设计或评审一个 plugin 时问：

1. **它是不是真的需要看 agent 内部执行节点？**
   - 不需要 → 写成 model/tool 的包装函数，不要做成 plugin
2. **它的逻辑能不能用 4 个钩子表达？**
   - 不能 → 要么需求超出 framework 能力（去 harness 层做），要么是想偷塞中间件
3. **它依赖什么？**
   - 只依赖 `core` 的类型 → 可以放 framework 包
   - 依赖具体 model / 具体 tool / system prompt / CLI / fs 之外的环境 → 放 harness
4. **多个实例之间是否需要通信？**
   - 需要 → 合并成一个 plugin，**不要**给 framework 加 emit/state
5. **失败时是阻断主流程还是吞掉？**
   - before* 抛错 = 阻断 agent（符合 transformer 语义）
   - after* 抛错 = 必须吞掉 + warn（符合 observer 语义）

---

## 总结

**Plugin = framework 的扩展点 = 在 4 个固定时机插入横切逻辑的能力**。

- 存在性来自第一性事实：横切扩展无法用纯函数包装解决
- 能力边界严格收窄到 4 个钩子，**故意不给更多**
- 两类（transformer / observer）语义不同，类型层面隔离
- framework 内化能力分层：Plugin 做修饰和观察（零内置），ContextManager 做空间塑形，Checkpointer 做持久化，Logger 做日志。四个概念正交，各司其职
- 不是 middleware、不是 decorator、不是 event bus —— **是 framework 唯一的扩展点，没有第二种**
