# @my-agent-team/event-log

一个持久化的、只追加（append-only）的事件存储。运行子进程把 agent 产生的事件按发生顺序写进来，后端、审计、回放等读取方再按序读出或实时订阅。它定义了 `EventLog` 这个端口（port），并提供 SQLite 和内存两种实现。

## 为什么需要它 / 解决什么问题

一次 agent run 会产生一连串事件（模型输出、工具调用、todo 更新等）。写事件的一方（run 子进程）和看事件的一方（后端 SSE、审计、回放）往往不在同一个进程里，生命周期也不一致：run 可能早就结束了，前端才来订阅它的历史。

要让这两端解耦，需要一个中间的事实账本：写入方只管按时间顺序把事件追加进去，读取方既能拉取一段历史，也能在 run 仍在进行时实时跟读后续。这个包就是这个账本的抽象与落地。它刻意只做两件事——追加和读取/订阅，不修改、不删除，从而保证事件流是一份可信、可重放的记录。

职责边界很清晰：它只搬运 `AgentEvent`，永远不接触模型，也不解释事件含义。事件的产生在 framework/runner 层，事件的投影在后端层。

## 核心概念

存储被拆成读写两个角色接口，组合成完整的 `EventLog`：

- `EventSink` —— 写入端，只有一个方法 `append(threadId, runId, event)`，返回这条记录被分配的单调递增序号 `seq`。
- `EventSource` —— 读取端，`read(query)` 拉取一批历史，`subscribe(query, opts?, signal?)` 返回一个异步可迭代流。
- `EventLog` —— 同时实现两者，是工厂返回的完整对象。

每条记录是一个 `EventRecord`：`{ seq, threadId, runId, event, ts }`。`seq` 是全局自增主键、保证顺序；`ts` 是追加时刻的毫秒时间戳，由存储在 append 时写入，调用方不需要提供。

读取通过 `ReadQuery` 过滤：`runId`、`threadId`、`afterSeq`（只取序号更大的）、`limit`。结果始终按 `seq` 升序返回。

`subscribe` 分两个阶段：先把符合条件、`seq` 大于 `afterSeq` 的历史记录全部回放出来，然后进入尾随轮询，持续吐出新追加的记录，直到传入的 `AbortSignal` 被触发。轮询间隔由第二个参数 `{ pollMs }` 控制，默认 250ms（导出为 `DEFAULT_POLL_MS`）。

SQLite 实现把事件存进 `event_log` 表（事件本体以 JSON 文本落库），开启 WAL 模式以支持读写并发，并在 `run_id` 和 `thread_id` 上建索引。内存实现则把记录存在数组里，订阅时用监听器唤醒、轮询兜底，适合测试。

## 怎么用

```ts
import { sqliteEventLog, type EventRecord } from "@my-agent-team/event-log";

// 传入数据库文件路径，或一个已打开的 bun:sqlite Database 实例
const log = sqliteEventLog({ db: "./events.db" });

// 写入端：追加事件，拿到分配的 seq
const seq = await log.append("thread-1", "run-1", {
  type: "todo_update",
  payload: { todos: [] },
});

// 读取端：拉取某个 run 的全部历史
const history: EventRecord[] = await log.read({ runId: "run-1" });

// 实时订阅：先回放历史，再尾随新事件，每 100ms 轮询一次
const ac = new AbortController();
for await (const rec of log.subscribe({ runId: "run-1" }, { pollMs: 100 }, ac.signal)) {
  console.log(rec.seq, rec.ts, rec.event);
}
```

测试场景可用 `inMemoryEventLog()` 替换，接口完全一致。

依赖关系：仅依赖 `@my-agent-team/framework` 提供的 `AgentEvent` 类型，SQLite 实现使用 Bun 内置的 `bun:sqlite`。包内被 `apps/backend` 使用。
