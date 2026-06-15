# Checkpointer

Framework 的**内化能力**——让 agent 能暂停、崩溃恢复、跨进程续跑。不是 plugin，不是配置项，是 framework 自身的持久化层。

---

## 它解决什么问题

Agent loop 跑起来后有两个硬需求：

1. **崩溃恢复** — 进程死了，下次能从最近的 tool 边界续跑，不重头来
2. **人机协同** — tool 执行到一半需要人做决策（"允许删这个目录吗？"），loop 暂停、进程退出、等人决定、新进程恢复

这两个需求指向同一个根：**执行状态必须活在进程外**。

---

## 存什么

Checkpointer 存两样东西：

| 内容 | 用途 | 更新频率 |
|------|------|---------|
| `thread.messages` 完整快照 | 崩溃后恢复上下文 | 每次 tool 完成、每轮 turn 结束、interrupt 发生时 |
| `InterruptState`（pendingTool + reason） | 人机协同的暂停点 | tool 抛 `InterruptSignal` 时写入，resume 时消费并删除 |

> **关键**：checkpointer 存的是**裁剪后的 messages**（经过 ContextManager 塑形、token-budget 压缩后的真实输入态），不是 EventLog 里的原始未裁剪事件。裁剪信息（哪些 message 被裁掉了）只存在于 checkpointer 的快照里——这就是为什么 EventLog 不能替代 checkpointer 做 resume。详见 [14-event-log §5.1](./14-event-log.md#51-为什么-eventlog-不能取代-checkpointer-做-resume)。

---

## 三层能力模型

接口按能力分层，每层**成对**实现（要么两个方法都有，要么都没有）：

| Tier | 方法 | 语义 | 缺失后果 |
|------|------|------|---------|
| 1 — 基础持久化 | `save` / `load` | 强制。不实现 = 不是 Checkpointer | — |
| 2 — 人机协同 | `saveInterrupt` / `consumeInterrupt` | 成对可选。支持 `InterruptSignal` | tool 抛中断时 throw（告知调用方"不支持中断"） |
| 3 — 内部审计 | `appendEvent` / `readEvents` | 成对可选。**已废弃为内部审计** | UX 投影走 EventLog，不受影响 |

> **Tier 3 的定位变化**：UX 投影 / SSE 回放已由 [EventLog](./14-event-log.md) 独家承担。Tier 3 保留为 checkpointer 内部审计用途，新部署可不实现。

`createAgent` 构造时校验成对契约——fail fast，不等到运行时才发现能力残缺。

---

## 中断与恢复流程

### 正常路径：tool 执行 → 中断 → 恢复

```
1. Tool 执行中遇到需要人决策 → throw InterruptSignal("permission_required", meta)
2. Framework 捕获 → save(messages) → saveInterrupt(state) → yield interrupted 事件 → generator 退出
3. 调用方拿到 interrupted 事件，展示给用户，收集决策
4. 调用方重新 createAgent（同 threadId + 同 checkpointer 配置）→ agent.resume(command)
5. Framework → consumeInterrupt() → 补 tool_result → 继续 runLoop
```

**关键点**：
- `InterruptSignal` **只在 `tool.execute()` 内部抛出时被识别**。Plugin `beforeTool`、ContextManager 等位置抛出的 `InterruptSignal` 按普通错误处理——中断的语义是"tool 想要外部决策"，锚点必须是当前 tool。
- `consumeInterrupt` 是读取即删除（read + unlink），防止双消费。
- Resume 时 framework 自动补一条 `tool_result`（`is_error = !approved`），然后继续 loop——不重新调 LLM。

### 推荐：用 `withPermission(tool, gating, reason)` 包装器做权限

```ts
const safeBash = withPermission(bashTool, (input) => isDangerous(input.command));
```

包装器在 `execute` 里抛 `InterruptSignal`——完全符合"识别边界 = tool.execute"契约。比在 plugin 的 `beforeTool` 里做更干净。

---

## 内置实现

| 实现 | 存储 | 适用场景 |
|------|------|---------|
| `inMemoryCheckpointer()` | `Map<threadId, messages>` | 测试、一次性脚本。默认 |
| `fileCheckpointer({ dir })` | JSON state + JSONL events | CLI、单机服务 |
| `redisCheckpointer` | Redis SET + XADD | 多进程、分布式 |

`fileCheckpointer` 关键特性：
- 每 thread 三个文件：`{threadId}.state.json`（快照）、`{threadId}.interrupt.json`（中断态）、`{threadId}.events.jsonl`（审计流）
- 快照用 tmp+rename 实现 POSIX 原子写——要么全旧内容，要么全新内容，无半截文件
- events 用 `O_APPEND` 追加——单行 < 4KB 时原子，多进程并发不撕裂行
- 不 fsync——接受极端断电丢最后一次 save

> 实现细节（threadId 校验规则、原子写代码）见源码。本页只保留概念模型。

---

## 与 Framework 的集成时机

Framework 在 5 个固定时机自动调 `save()`：
1. `run()` 入口 push user message 后
2. 每个 tool 执行完成 push tool_result 后
3. 每轮 turn 结束（assistant 无 tool_use）后
4. Interrupt 发生、yield interrupted 之前
5. `resume()` push tool_result 后

调用方不需要手动调——framework 保证 save 在正确的时机自动发生。

---

## 与其他组件的边界

| 组件 | 与 Checkpointer 的关系 |
|------|----------------------|
| **[EventLog](./14-event-log.md)** | Checkpointer 管"恢复"，EventLog 管"观测"。两者从 agent loop 同一时刻派生，但不互为上游。**EventLog 是 UX 投影的唯一事实源** |
| **[Plugin](./03-plugin.md)** | Plugin 可通过 `HookContext.checkpointer` **读**事件流（审计、metrics），但**禁止写**（save/saveInterrupt 是 framework 的职责） |
| **[ContextManager](./05-context-manager.md)** | Checkpointer 存的是 ContextManager 裁剪后的 messages；ContextManager 从 checkpointer 恢复的 messages 出发重新塑形 |
| **Backend [ThreadProjection](./12-backend.md)** | Backend 有自己的投影存储（`backend.db`），与 checkpointer 的 `state/checkpointer.sqlite` 物理隔离。上下文经 transport `preloadedMessages` 在 run 启动时 hydrate |

---

## 设计纪律

1. **Checkpointer 永远存在** — 不传 = `inMemoryCheckpointer`，framework 行为统一
2. **save 只在 messages 合法 API 输入态时触发** — 末尾必须是 `user(text)` / `user(tool_result)` / `assistant(text only)`。Interrupt 时末尾是 `assistant(tool_use)` 是唯一例外——保存但不送 LLM，resume 时补 tool_result 后恢复合法
3. **backend 不持有 checkpointer，不调 `agent.resume()`** — backend 只转发 checkpointer 连接配置给新 fork 的子进程，子进程内才调 resume
4. **plugin 可读不可写** — `ctx.checkpointer` 暴露给 plugin 是为了读事件流做审计，不是为了重写 framework 的 save 职责
