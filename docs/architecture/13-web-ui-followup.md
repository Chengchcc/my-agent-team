# M13 — Web UI Follow-up: Classic Agent Layout · True Streaming · M12 Defect Fixes

> 三件事并一份：收口 M12 P0/P1 缺陷；页面驱动改经典 Agent 侧边栏布局；liveItem 从假打字机升级为 delta stream → AST → 增量渲染。

---

## 〇、范围与不变量

**继承自 M12 且本期不动**：
- BFF 透明代理 + HMAC-SHA256 httpOnly session，token 永不入浏览器。
- EventLog 四铁律（append-only / seq 单调 / schema-agnostic / 可续传）。
- `/events`（message 级、durable、可 Last-Event-ID 续传）作为权威事件流。
- 历史快照 = `GET /threads/:id/messages` → `checkpoint_messages.messages`（`Message[]`，无 seq、无 id）。

**本期新增的唯一底座改动**：
- `/stream`（text_delta 级、ephemeral、不入 EventLog）——supervisor stdout handler 按 type 分流，delta 走内存 fan-out。
- Framework 新增第四类 `AgentEvent`：`{ type: "text_delta"; payload: { blockIndex: number; text: string } }`。**`run()` 默认不 yield**，仅 `{ stream: true }` 时透出。向后兼容，所有现有消费者零改动。
- delta 仍**绝不**写 EventLog。

**Q&A 裁决**：

| # | 问题 | 裁决 |
|---|------|------|
| Q1 | text_delta 来源 | A — 框架加 `text_delta` AgentEvent，`run({stream:true})` 才透出。只增不改，向后兼容 |
| Q2 | AppShell 范围 | 全局壳 — NavRail 所有已登录页常驻。Drawer 仅 thread workspace。Main slot 内容按路由切换 |
| Q3 | Main Canvas 空态 | 三态：身份卡占位 / 进度镜像 / 重内容 canvas。永不全白 |
| Q4 | routeItem 阈值 | N=600 字符。code fence/table 无视字数一律上浮。多块全上浮，Drawer 留锚点摘要 |
| Q5 | supervisor fan-out | `subscribeDelta(runId) → ReadableStream`，stdout handler 按 type 分流：text_delta→fan-out，其余→double-write |
| Q6 | /stream 路径 | `GET /api/runs/:id/stream`，BFF 代理。done 时两个 EventSource 都关 |
| Q7 | 分支策略 | 直接在 master 开发，推到 origin/next |

---

## 一、M12 缺陷收口（C1 — 独立 commit）

**P0-1 乐观消息排序错乱**
- 位置 `useTimeline.ts:68`：`[...historyItems, ...liveItems, ...lead]` → `[...historyItems, ...lead, ...liveItems]`
- 子修复 `ChatWorkspace.tsx:54`：乐观项清除改为仅当 live 中出现 `role==="user"` echo 时清，不在"任意 live 事件"时清

**P1-1 错误信息永久丢失**
- 位置 `ChatWorkspace.tsx:190`：`payload.error` → `payload.message`；保留 `stack` 折叠展示（dev）

**P1-2 无 id 事件被静默吞**
- 位置 `useLiveEvents.ts:70`：仅当 `e.lastEventId` 存在才 dedup；无 id 事件一律保留

**P1-3 live 项 index key → 动画 remount**
- 位置 `Timeline.tsx:114/123/135`：live 项透传 `seq` 作 key；history 项保留 index

**P1-4 middleware 静态资源启发式过宽**
- 位置 `middleware.ts:19`：`pathname.includes(".")` 删除，改 `config.matcher` 显式排除 `_next` / 静态扩展名白名单

**测试**：P1-1/P1-2/P1-3 各补一条断言型测试。

---

## 二、布局：从页面驱动到侧边栏 Agent 工作台

### 机制

三栏壳 AppShell（全局）+ NavRail（全局）+ MainCanvas（按路由）+ AgentDrawer（仅 thread）。

```
┌──────────┬───────────────────────────────┬───────────────────┐
│ Rail     │  Main Work Surface            │  Agent Drawer     │
│ (Nav)    │  (任务对象)                    │  (过程控制台)      │
│          │                               │                   │
│ Agents   │  列表页：AgentList+AgentForm    │  ┌─ Conversation  │
│ Threads  │  thread页：重内容canvas         │  ├─ Plan / Steps  │
│ ◦ a1     │                               │  ├─ Tool calls    │
│ ◦ a2     │  ← 主内容不被对话抢占            │  ├─ Logs          │
│          │                               │  └─ 待确认事项     │
│ [收起]    │                               │  [展开/收起]       │
└──────────┴───────────────────────────────┴───────────────────┘
```

**三区职责**：
- **Rail（左·导航）**：Agent 列表 + Thread 列表，可折叠成图标条。所有已登录页常驻。
- **Main（中·任务对象区）**：路由切换内容。列表页=AgentList+AgentForm，thread 页=重内容 canvas + 空态/进度镜像。
- **Drawer（右·过程控制台）**：仅 thread workspace 出现。对话、tool 调用、interrupt 审批、composer。

**Main Canvas 三态**：
1. **空态**（刚进 thread、无重内容）：agent 身份卡（SOUL 摘要 + 最近 memory）+ "输出将在此呈现"
2. **进度镜像**（模型思考中/tool 执行中）：当前 step / tool 名 / status badge，从 Drawer Timeline 投影一行
3. **重内容 canvas**：code fence / table / >600字 markdown 的聚合视图

**关键决策**：
- Shell 是布局壳，不是数据层。复用 M12 全部 hook。重构是搬运 + 重组 DOM。
- Drawer 用 CSS grid 列宽 + `transform` 折叠，不卸载组件（保留 EventSource 连接与滚动位置）。
- Rail/Drawer 折叠态写 `localStorage`。
- **TimelineItem 分流**：纯函数 `routeItem(item) → "drawer" | "main"`。>600 字符 / code fence / table → Main；其余 → Drawer。多块全上浮，Drawer 留 "→ 已在主区展示" 锚点。
- 移动端：Drawer 退化为底部抽屉（slide-up），Main 全宽，Rail 收图标条。断点 768px。

**组件清单**：
- 新 `AppShell`（grid 容器 + 折叠状态）、`NavRail`、`AgentDrawer`、`MainCanvas`。
- 改 `ChatWorkspace` → 拆为 `DrawerConversation`（对话/审批/composer）+ `MainCanvas`（重输出），由 `AppShell` 编排。
- `Timeline` 拆为 `DrawerTimeline`（过程流）与 canvas 渲染路径，共用底层 block renderer（见 §三）。

### 路由结构

```
app/
  layout.tsx                          ← 根 layout（QueryProvider + metadata）
  (auth)/login/page.tsx               ← 登录页，无壳
  (main)/
    layout.tsx                        ← NEW: AppShell 包裹（NavRail + Main + Drawer slot）
    agents/
      page.tsx                        ← 列表 → Main slot
      [id]/page.tsx                   ← 详情 → Main slot
    threads/
      [id]/page.tsx                   ← thread → Main + Drawer
```

---

## 三、真流式渲染：stream 事件 → AST → renderer

### 机制

liveItem 不再"等整条 message 回来再前端假打字机"，而是订阅 `/stream` 的 text_delta，增量喂给流式 markdown 解析器，维护一棵可变 AST，renderer 按 AST 节点增量渲染。

**双流分工**：
```
/events  (durable, seq)   → message 定稿、tool_use/tool_result、interrupted、error、done
/stream  (ephemeral)      → text_delta（仅 assistant 文本增量），不入 EventLog
```

### 数据流

```
agent.run({stream:true}) → AgentEvent yield
  ├─ text_delta → writeDelta(stdout) → supervisor fan-out → /stream SSE → useDeltaStream
  └─ message    → writeEvent(stdout) → sink.append(EventLog) → /events SSE → useLiveEvents
                                                                    ↓
                                           /events 完整 message 到达 → finalizeBlock 对齐
```

### Framework 变更

```ts
// AgentEvent 新增第四种（只增不改）
export type AgentEvent =
  | { type: "message"; payload: Message }
  | { type: "interrupted"; payload: Interrupt }
  | { type: "error"; payload: { message: string; stack?: string } }
  | { type: "text_delta"; payload: { blockIndex: number; text: string } };  // NEW

// run() 新增 stream 选项，默认 false（向后兼容）
interface RunOptions {
  signal?: AbortSignal;
  maxSteps?: number;
  stream?: boolean;  // NEW — only then text_delta is yielded
}
```

### Runner 变更

```ts
// EntryIO 新增 writeDelta
export interface EntryIO {
  writeDelta: (delta: { blockIndex: number; text: string }) => void;  // NEW — stdout only, no sink
  // ... 其余不变
}

// 主循环分流
for await (const ev of stream) {
  if (ev.type === "text_delta") {
    io.writeDelta({ blockIndex: ev.payload.blockIndex, text: ev.payload.text });
    // NEVER call sink.append for text_delta
  } else {
    if (sink) await sink.append(...);
    io.writeEvent(ev);
  }
}
```

### Supervisor 变更

stdout handler 按 type 分流：

```
stdout NDJSON → JSON.parse
  ├─ type === "text_delta" → fan-out to subscribeDelta subscribers (in-memory ONLY)
  └─ other types            → eventLog.append (existing double-write, best-effort)
```

新增：
```ts
class RunSupervisor {
  #deltaSubs = new Map<string, Set<ReadableStreamDefaultController>>();

  subscribeDelta(runId: string): ReadableStream {
    // Returns a ReadableStream that receives text_delta payloads
    // Controller removed on stream close or run exit
  }
}
```

### Backend HTTP 新增

- `GET /api/runs/:id/stream` → `svc.deltaStream(runId)` → `supervisor.subscribeDelta(runId)` → `sseResponse()`
- BFF catch-all 自动代理到 `/api/bff/runs/:id/stream`

### Frontend

**stream-ast.ts**（新 lib）：
```ts
interface StreamAst {
  blocks: AstBlock[];          // paragraph | heading | code | list | table
  openBlock: AstBlock | null;  // 当前未闭合块
  buffer: string;
}

function appendDelta(ast: StreamAst, blockIndex: number, text: string): Patch[] {
  // 增量追加：buffer + text，只在块边界（\n\n / ``` / 表格行）封口开新块
  // 返回最小 patch 集给 renderer
}

function finalizeBlock(ast: StreamAst, blockIndex: number, authoritative: Message): void {
  // /events 完整 message 覆盖 delta 拼出的文本，修正流式期误判
}
```

**useDeltaStream(runId)**（新 hook）：
- 独立 EventSource → `/api/bff/runs/:id/stream`
- 维护 StreamAst，rAF 批量合并 delta
- `/stream` 不可用（404/连接失败）→ console.warn + 自动回退 M12 打字机
- 重连：不重放 delta，靠 /events Last-Event-ID 续传 + 一次性补齐

**StreamingBlocks**（新组件）：
- 按 `blockIndex` 作 key（稳定，跨 patch）
- 增量挂载，绝不整树重渲
- `StreamingMessage` 保留为 fallback

**降级链**：`/stream` 不可用 → StreamingMessage 打字机（M12 行为）

**背压**：rAF 批处理，一帧合并多个 delta 再 patch

---

## 四、分阶段交付

```
C1  缺陷收口（§一）              ──► 独立 commit，6 fix + 3 测试
C2  AppShell 三栏壳 + 折叠        ──► 全局壳，复用旧 hook，行为等价
C3  ChatWorkspace 拆分            ──► DrawerConversation + MainCanvas + routeItem
C4  /stream 底座打通              ──► framework text_delta + supervisor fan-out + BFF route
C5  stream-ast + StreamingBlocks  ──► appendDelta/finalizeBlock + 增量 renderer
C6  useDeltaStream 接线 + 降级链  ──► /stream↔/events 对齐、fallback、rAF 背压
C7  集成冒烟（每阶段后做，不攒）   ──► 三层 SSE 真实流式 + abort + 重连
```

**纪律**：每个 Phase 结束做端到端冒烟，不攒到最后。Env fail-fast（`/stream` 上游缺失显式降级日志，不静默）。

---

## 五、默认值与边界

| 项 | 默认 | 说明 |
|---|---|---|
| Drawer 默认态 | 展开 | thread 视图进入即可对话 |
| Rail 默认态 | 展开（桌面）/ 图标条（窄屏） | 折叠态存 localStorage |
| `/stream` | 启用，失败自动降级 | 不可用回退 M12 打字机 |
| delta 批处理 | rAF 合并 | 一帧一次 patch |
| 重连 delta | 不重放 | 靠 /events 定稿补齐 |
| routeItem 阈值 | 600 字符 / code fence / table | 全上浮 Main，Drawer 留锚点 |
| key 策略 | history=index, live=seq, block=blockIndex | 禁 Math.random |
| `run({stream})` | 默认 `false` | 向后兼容，仅 runner 传 `true` |

---

## 六、与 M12 的边界承诺

- **不改**：EventLog schema、四铁律、`/events` 协议、checkpoint 历史格式、session/BFF 鉴权模型、backend 进程协议。
- **只加**：`/stream`（ephemeral 旁路）、布局壳、AST renderer、`text_delta` AgentEvent（可选透出）。
- **可回退**：`/stream` 整条链路降级即回到 M12 纯 `/events` + 打字机，功能不缺。

---

**Spec 结束。**
