# Conversation Message Revisions — 统一 Web / Lark 流式消息修复

> **Status:** Spec → Ready for implementation.
> **Baseline commit:** `origin/master` @ `d79b2ba`.
> **关联:** `docs/architecture/backend/conversation-projection.md` · `docs/architecture/flows/e2e-web-message.md` · `docs/architecture/flows/e2e-lark-message.md` · `docs/architecture/conversation/ledger.md` · `apps/backend/src/main.ts` · `apps/web/src/hooks/useConversation.ts` · `apps/lark-bot/src/sse-watcher.ts`.

## 一句话定位

把 Web 和 Lark 的用户可见输出统一成 **conversation ledger 上同一条 `messageId` 的多次 revision**。长文本仍然流式增长，但不再由 Web `draft`、Lark `run-delta-watcher`、`/runs/:id/events`、`/runs/:id/stream` 各自拼状态。所有 surface 只渲染 conversation ledger；run/delta 退回后端执行细节。

---

## 一、问题

### 1.1 现象

Web 会话 `d48fa053d0ac4bbdab33e6099e` 中，User + coder 发送「分析一下当前目录」后：

1. Agent run 已 succeeded，最终输出可见。
2. 消息列表底部残留一个空 assistant 气泡和闪烁光标。
3. 输入框锁死。
4. 顶部显示 `Connection lost — reconnecting…`。
5. 刷新后空气泡消失。

### 1.2 四个根因

完整诊断见 `memory/web_e2e_stuck_draft.md`。核心故障链：

1. **Run SSE 断开后无重试** — `es.onerror` 只调一次 `api.getRun`，失败就放弃，`run/done` 永不 dispatch，`phase` 永卡 `running`。
2. **Draft 和 ledger 消息是两套东西** — draft 来自 run SSE `stream/toolStart`，ledger 消息来自 conversation SSE。两者独立，`clearsDraft` 需要 `phase !== "running"` 才触发。
3. **Todo list 不清空** — `run/started` 和 `run/done` 都不清 `todos`。
4. **Conversation SSE 无心跳 + 60s 空闲超时** — `maxEmptyPolls=120` 导致无限重连循环。

根本上，用户可见输出由多条链路拼出来（ledger、delta、run events、SSE close），生命周期不同，拼成一个 UI 状态机必然出现顺序和断线 race。

### 1.3 Lark 也有同类问题

Lark 同时订 conversation ledger 和 `/api/runs/:runId/stream` 更新卡片。最终答案可能从流式卡片和 ledger 文本两条路同时出现，去重依赖 runId、卡片状态、fallback 状态和 ledger 到达顺序。同源于 surface 自己消费 run delta 而非只渲染会话事实。

---

## 二、第一性原则

### 2.1 用户看到的是消息，不是 run

用户不需要感知 run event、delta stream、EventLog seq、SSE close、draft、done fallback。

### 2.2 流式输出是同一条消息的 revision

```text
messageId=m1  state=streaming  text=""
messageId=m1  state=streaming  text="我先查看目录..."
messageId=m1  state=streaming  text="我先查看目录...\n发现..."
messageId=m1  state=done       text="完整结论..."
```

### 2.3 Surface 是 renderer

Web：`messageId -> React 气泡`。Lark：`messageId -> Lark card/message binding`。同一条 ledger revision，不同 surface 渲染成不同 UI，但事实源相同。

### 2.4 吸收 LangGraph SDK 的轻量思路

Stream controller 拥有 stream 生命周期，stream event 先投影进 store，UI selector 读 store。本项目只吸收控制思想，不引入 namespace/subgraph。

---

## 三、不变量

1. Conversation ledger 是所有 surface 的唯一可见输出事实源。
2. 流式输出是 message revision，同一 `messageId` 在 UI 上 upsert 成同一个气泡/卡片。
3. `seq` 只表示账本事件顺序，UI 以 `messageId` 为主键。
4. 每个 open message 最终必须收到 `state=done/error` revision。
5. SSE close 不表达业务完成。业务完成只能由 message revision 的 `state` 表达。
6. Web 不维护 draft。
7. Lark 不维护 run-delta 主链路，不提供灰度回切路径。
8. Conversation SSE 必须长连接，空闲是正常状态，不对端 close。
9. 旧数据兼容：没有 `messageId` 的旧条目按 `s-${seq}` 展示。

---

## 四、数据模型

### 4.1 Message revision envelope

```ts
type MessageRevisionState = "streaming" | "waiting" | "done" | "error";

type MessageToolRevision = {
  id: string;
  name: string;
  state: "running" | "done" | "error";
  isError?: boolean;
};

type ConversationMessageRevision = {
  messageId: string;
  state: MessageRevisionState;
  role?: "assistant" | "user";
  text?: string;
  blocks?: ContentBlock[];
  tools?: MessageToolRevision[];
  runId?: string;
  error?: string;
};
```

### 4.2 messageId 生成

```ts
messageId = `run:${runId}:assistant:0`;
```

### 4.3 旧 content 兼容

```ts
const id = envelope.messageId ?? `s-${seq}`;
const state = envelope.state ?? "done";
```

---

## 五至八、实现设计

（完整设计见上方 spec 原文第 6-8 节，此处不重复。）

---

## 九、代码改动清单

### Part A — 后端

```text
apps/backend/src/main.ts
  - RunAccumulator 增 latestAssistantRevision / projectionChain
  - projectRunMessageToLedger 改为写 ConversationMessageRevision envelope
  - onRunEvent 串行 enqueue projection
  - interrupted 写 waiting revision
  - onRunComplete 等待 projectionChain 后写 done/error revision

apps/backend/src/features/conversation/service.ts
  - subscribeConversation 删除 maxEmptyPolls，加 heartbeat

apps/backend/src/http/response.ts
  - sseResponse 写入 SSE comment heartbeat，不发业务 done

apps/backend/src/features/run/service.ts
  - mergedStream 删除或标 deprecated

apps/backend/src/features/run/http.ts
  - /runs/:id/stream 不再被 Web/Lark surface 消费
```

### Part B — Web

```text
apps/web/src/lib/conversation-reducer.ts
  - 删除 Draft / draft / stream actions / run.phase / draft
  - ledger/message 以 messageId upsert
  - busy 从 open assistant message state 派生

apps/web/src/hooks/useConversation.ts
  - 删除 run EventSource（/runs/:id/events）
  - 保留 conversation SSE 作为唯一消息入口

apps/web/src/lib/api.ts
  - 增 ConversationMessageRevision 类型
```

### Part C — Lark

```text
apps/lark-bot/src/sse-watcher.ts
  - message event 改为 parse revision + render by messageId

apps/lark-bot/src/run-delta-watcher.ts
  - 从 production 主链路删除

apps/lark-bot/src/bindings-sqlite.ts
  - 新增 message_delivery 表

apps/lark-bot/src/main.ts
  - 删除 watchRunDelta production import/call
```

### Part D — 文档

```text
docs/architecture/backend/conversation-projection.md
docs/architecture/flows/e2e-web-message.md
docs/architecture/flows/e2e-lark-message.md
docs/architecture/surfaces/web.md
docs/architecture/surfaces/lark-adapter.md
```

---

## 十、实施步骤

### Commit 1 — 定义 revision envelope 与 parser
### Commit 2 — Backend Projection 写 messageId/state
### Commit 3 — Web upsert by messageId，删除 draft
### Commit 4 — Conversation SSE 长连接
### Commit 5 — Lark ledger revision renderer
### Commit 6 — 删除/降级 merged stream 与更新文档

验收标准与测试计划见上方 spec 原文。
