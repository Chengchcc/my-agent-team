# M14 Spec — 前端真实引入 Conversation（废除 thread 二元视图，全量 conversation 化）

> M14 把 `apps/web` 从 **thread-binary 模型**（`role: "user" | "assistant"`，隐式 `user === 我`）升级为 **conversation 模型**（N 个成员、绝对 `senderMemberId`、self 为相对渲染量）。后端 conversation feature 早已落地（M10，`POST /conversations`、`/messages`、`GET /conversations/:id/events`），M14 是**纯前端 + 一个后端只读快照端点**的工作：让 Web UI 直接消费 ledger，而非 `/threads` + `/runs` 的单 agent 退化通道。
>
> 背景：M13.2（`0838eba`）已把渲染流重构成 **单一 reducer + 至多一条 draft** 的纯函数状态机。M14 **不重写它**，而是把它的二元 `role` 泛化成 `sender: SenderRef`，把数据源从 `/threads/:id/messages` + `/runs/:id/events` 换成 `/conversations/:id/events`（ledger SSE）。M13.2 的"对齐 / 去重 / 互斥"成果原样继承。
>
> 关联：[14-conversation](../../architecture/14-conversation.md)（持久架构） · [14-conversation-design-decisions](../../architecture/14-conversation-design-decisions.md)（M10 实现级决策） · [M13.2 spec](./2026-06-09-m13.2-render-refactor.md)（被泛化的 reducer 基线）。

---

## 一、定位

M14 是 **前端 conversation 化 + 后端一个只读快照端点**：

- 改 `lib/conversation-reducer.ts` — `UiMessage.role` → `UiMessage.sender: SenderRef`；`Draft` 增 `agentMemberId`；新增 roster（成员名册）从 ledger `member.joined/left` 重建；新增 `viewerMemberId`
- 改 `hooks/useConversation.ts` — 数据源换为 `/conversations/:id/events`（ledger SSE，一条流覆盖全部成员发言 + 成员事件 + 系统消息）；发送走 `POST /conversations/:id/messages`；run 级 token/tool 细节仍按需订阅 `/runs/:id/stream`
- 改 `lib/api.ts` — 新增 conversation 端点封装，`Message` 旁新增 `LedgerEntry` 类型
- 改 `components/Timeline.tsx` / `MessageBubble` — 渲染按 `isSelf = sender.memberId === viewerMemberId` 决定左右，`!isSelf` 时按 `sender.kind` 显示 agent / human 名牌
- 新增后端 `GET /api/conversations/:id` — 只读快照（conversation 元信息 + members 名册），供首屏 roster bootstrap（D1）
- 删 `/threads`-binary 渲染路径（不并存，D3）

**核心不变量**：ledger 只存**绝对 `senderMemberId`**；"是不是我发的"是 surface 侧的**相对派生量** `isSelf(entry) = entry.senderMemberId === viewerMemberId`。conversation 模型里**不存在固定的 "You" role**。

**M14 显式不做（边界）**：

- **不接 IM**（IM adapter = M15）；不做多真人协作 UI；不做 NLP `@` 自由文本解析（D5）
- **不接 SSO/IdP**；跨 surface "同一个人" 的身份合并显式留给未来 `identityRef`（见 §三.3）
- **不动后端协作语义** — conversation service / ledger / 广播投影 / 两道安全阀一行不改；唯一后端改动是新增只读 `GET /conversations/:id` 快照端点
- **不保留 thread 二元视图** — 全量 conversation 化，无 thread fallback（D3，避免技术债）

---

## 二、问题根因（M14 要消除的）

```text
thread-binary  ← UiMessage.role: "user"|"assistant" 隐含 user===我
   崩溃点 1     ← 多 sender 时 "user" 指谁不明（真人 A/真人 B/别的 agent 都成 user）
   崩溃点 2     ← IM 群多真人会被二元 role 塌缩成一个 "user"（M15 直接报废该模型）
   崩溃点 3     ← 前端只会 /threads + /runs，看不见 ledger 里的成员事件/他人发言
共同根因       ← "self" 被当成存储维度的绝对 role，而非渲染维度的相对量
```

修复后：**self 从存储层踢到渲染层**。ledger 永远只记绝对 `senderMemberId`，每个 surface 自己决定哪个 memberId 渲染成 self——这正是 [14-conversation §八](../../architecture/14-conversation.md)"身份系统是更上层 surface 的事"的落地。

---

## 三、设计原则与三个关键决策

沿用项目既有原则（单一真值、对齐前移纯函数、奥卡姆剃刀），强化三条 conversation 专属决策：

### 3.1 "You" role 重新设计 —— self 是相对渲染量，不是绝对 role

M13.2 的二元 `role` 废除。`UiMessage` 改记**绝对** sender：

```ts
interface SenderRef {
  memberId: string;
  kind: "agent" | "human" | "system";
  displayName?: string;
}
interface UiMessage { id: string; sender: SenderRef; content: string | ContentBlock[]; }
```

渲染时**派生**相对角色：

```ts
const isSelf = (m: UiMessage, viewerMemberId: string) => m.sender.memberId === viewerMemberId;
// isSelf → 右对齐、无名牌（旧 "You"）
// !isSelf && kind==="agent"  → 左对齐气泡 + agent 名牌
// !isSelf && kind==="human"  → 左对齐 + 真人名牌
// kind==="system"            → 居中系统条
```

**降级等价**：单 agent + 单真人会话里，viewer 自己的消息渲染成 self（右），agent 的渲染成 other/agent（左）——视觉与 M13.2 两栏完全一致，底层已是 conversation。

### 3.2 viewerMemberId 从哪来（web，D2 单一真人观察者）

后端只有单一 `X-Auth-Token`，**无 per-user 身份**。但 M10 backfill 已为每条 legacy thread 建了一个 `HumanMember`（`memberId = human-${threadId}`，`userRef = "__legacy__"`，`displayName = "User"`）。所以 **viewerMemberId 不需要额外 config**：

> **D2 落地**：web 进入会话时，从 roster 里**挑唯一一个 `kind==="human"` 的 member 作为 viewer**。单真人场景下它必然唯一（backfill 保证）。新建会话时 web 显式带一个 HumanMember 进 `POST /conversations`，记下其 `memberId` 即 `viewerMemberId`（存 localStorage 兜底）。

```ts
function resolveViewerMemberId(roster: SenderRef[]): string {
  const humans = roster.filter((m) => m.kind === "human");
  return humans[0]?.memberId ?? "";   // D2: 单真人，取唯一 human
}
```

身份解析 100% 在 surface 内闭环，backend 完全不知道"谁是我"。

### 3.3 web 输入怎么投影到 SenderRef + 接入 IM 后怎么确认"同一个人"

**web 输入投影**：前端已持有 `viewerMemberId`，发消息是一次**直接装配，无任何反查**：

```ts
function sendUserInput(text: string) {
  // 1. 乐观渲染：直接用 viewerMemberId 拼 SenderRef
  dispatch({ type: "send", text, viewer: viewerRef });   // viewerRef = {memberId, kind:"human", displayName}
  // 2. 发后端：只传绝对 senderMemberId，不传 SenderRef
  api.postConversationMessage(conversationId, {
    senderMemberId: viewerMemberId,
    addressedTo: resolveAddressedTo(),   // 单 agent 退化 = 唯一 agent member 的 memberId
    content: text,
  });
}
```

要点：**SenderRef 是渲染态，不是传输态**。传输层只走绝对 `memberId`；`kind`/`displayName` 由前端从 roster（ledger `member.joined` 重建）查出来自己拼。乐观消息等 ledger SSE 把权威 entry（`senderMemberId === viewerMemberId`）推回后由 `upsertAuthoritative` 替换 `opt-` 前缀——M13.2 已有，M14 仅把"role=user 匹配"改成"sender.memberId 匹配"。

**接入 IM 后怎么确认"同一个人"**——分两层，M14 都不做合并：

| 层 | 问题 | M14/M15 方案 |
|---|---|---|
| **同 surface 内稳定性**（M15 IM adapter 必做） | 同一 IM 用户每次映射到同一 HumanMember | `userRef = "lark:" + open_id` 做幂等主键；`open_id` 单租户内稳定唯一，直接当主键，无模糊匹配 |
| **跨 surface 同一人**（web 的"我" vs IM 里某人） | web `userRef="__legacy__"`/占位 与 `userRef="lark:ou_xxx"` 是不同命名空间 | **不做**。无 IdP 时没有可信信号断言两 ref 是同一自然人，强行合并 = 伪造身份 = 技术债。每个 surface 每个真人各自一个 HumanMember |

> **立场**："是不是同一个人"永远是 `userRef → identity` 的**解析**问题，不是 `memberId` 合并问题。未来接 IdP 时，在 Member 上加可选 `identityRef`，由 IdP 把 `__legacy__` 与 `lark:ou_xxx` 都解析到同一 `identityId`——届时合并是 surface 之上一层映射，**ledger 一行不动**。这就是"把相对量挡在存储层之外"带来的可扩展性。

### 3.4 member 事件投影：为何是 user role，不是 system prompt

后端**已落地**：`projectForMember` 把 `member.joined`/`member.left` 投影成 **`role: "user"`** 的对话消息（文本 `[系统] 成员变化：Y 加入。当前在场：H, X, Y`），经 `checkpointWrite.appendMessages` 追加进每个 agent 的 `thread.messages`（[service.ts:107-123](../../../apps/backend/src/features/conversation/service.ts)、[index.ts:124](../../../packages/conversation/src/index.ts)）。而 `systemPrompt` 是 framework 在 run 启动时**一次性 unshift 到 `messages[0]` 且去重**（`!some(m.role==="system")`），全生命周期只有一条 system——就是 agent 人格 SOUL（[create-agent.ts:390](../../../packages/framework/src/create-agent.ts)）。

**M14 决策：member 事件继续走 user role 注入对话流，绝不进 system prompt。** 三条第一性理由：

1. **system 是"恒定人格"，member 变化是"时序事件"。** "Y 在 seq=12 加入"必须出现在时间线那个位置，X 才能理解"我 @Y 之前 Y 不在、之后在"。塞进 system prompt 丢时序，且每次成员变化都要重写 system、破坏 framework "只有一条 system 不重写"的不变量。
2. **与真人发言同构。** [14-conversation §三 三方同构](../../architecture/14-conversation.md) 铁律：真人/agent/系统走同一条 ledger→广播链路、无特例分支。member 事件作为对话流消息正好保持同构；抽进 system 就开特例。
3. **M9 恢复零改动。** 投影进 `thread.messages` 经 checkpointer，agent 子进程从 checkpointer 恢复时天然带着它，"agent 只认 checkpointer、不认识 ledger" 不变（[§五](../../architecture/14-conversation.md)）。改 system prompt 注入则侵入 run 启动路径。

> **已知限制（留作不变量备注，M14 不改）**：投影成 `role:"user"` + `[系统]` 前缀，LLM 理论上可能把成员事件误读成真人发言。更干净是投影成 mid-stream `role:"system"` 普通消息，但 `appendMessages` 签名是 `unknown[]`、provider 是否接受 mid-stream system 取决于模型——属 provider 兼容性问题，保持现状前缀方案，不在 M14 动。

---

## 四、交付范围（LOC 级设计）

> 基于已核实的真实契约：ledger SSE entry `{ seq, conversationId, senderMemberId, addressedTo, kind, content(JSON string), ts }`（`adapter-sqlite.ts:135`）；`kind ∈ "message"|"member.joined"|"member.left"`；`__system__` 为系统发送者；`POST /conversations/:id/messages` body `{ senderMemberId, addressedTo[], content }` → 202 `{ seq, triggeredRuns }`；`GET /conversations/:id/events` SSE 从 `?afterSeq` 或 `Last-Event-ID` 回放，`event` = entry.kind。

### 4.0 现网代码对齐基线（已 checkout `origin/next` @ 30b12e6 核对）

落地前已用真实代码核对，以下 4 点校准（设计骨架不变，均为实现细节）：

1. **两种 SSE 的 payload 结构不同，解析逻辑必须分开**：
   - `GET /runs/:id/events`（run 级）：`{ type, payload }` **包了一层**，`payload = { role, content }`（`useConversation.ts:64`）。
   - `GET /conversations/:id/events`（会话级）：**扁平 ledger entry** `{ seq, senderMemberId, addressedTo, kind, content, ts }`，`content` 是 JSON 字符串需二次 parse。
   - M14 把数据源主轴换成会话级 SSE（扁平结构）；run 级 SSE 仅保留 `/stream`（token/tool）+ `done`（完成兜底）。
2. **`stream/delta` 带 `blockIndex`** —— 现网 `text_delta` payload 是 `{ blockIndex, text }`（`useConversation.ts:113`）。M14 reducer 的 `stream/delta` action 保留 `blockIndex` 字段透传，不丢。
3. **清除现网 dead guard** —— `useConversation.ts:48` 的 `if (runId === runIdRef.current && runIdRef.current !== runId) return;` 恒为 false（死代码，M13.2 review 已识别）。M14 重写 hook 时一并删除 `runIdRef`。
4. **首屏 bootstrap 走 server component 直连**，非 client `useQuery` —— 现网 `threads/[id]/page.tsx` 是 async server component，服务端用 `fetchCurrentRun` 直连 backend（`x-auth-token`）。M14 的会话快照同理：新建 `conversations/[id]/page.tsx`，服务端直连 `GET /api/conversations/:id` 拿 roster + viewerMemberId，作为 props 注入 `ConversationCanvas`（§4.4 的 client `useQuery` 改为可选的 re-fetch 兜底）。

### 4.1 后端新增 `GET /api/conversations/:id`（只读快照，D1）

`http.ts` 新增一个 handler（service 已有 `port.getConversation` / `port.getMembers`，零 service 改动）：

```ts
/** GET /api/conversations/:id → 200 { conversationId, triggerMode, members } */
async snapshot(_req: Request, conversationId: string): Promise<Response> {
  const conv = svc.port.getConversation(conversationId);
  if (!conv) return json({ error: "Not found" }, 404);
  const members = svc.port.getMembers(conversationId);
  return json({
    conversationId,
    triggerMode: conv.triggerMode,
    hopCount: conv.hopCount,
    members,   // [{ memberId, kind, agentId?, userRef?, displayName? }]
  });
}
```

`router.ts` 在 conversation 段加一条（紧邻 `convEventsMatch`）：

```ts
const convSnapMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
if (convSnapMatch && method === "GET")
  return withAuth((r) => conversations.snapshot(r, convSnapMatch[1]!), token)(req);
if (convSnapMatch)
  return json({ error: "Method not allowed" }, 405);
```

> 为何要快照端点：SSE 从 seq 0 回放虽能重建 roster，但首屏需要在订阅前就拿到 `members` 解析 `viewerMemberId` + 渲染侧边栏；快照 = roster bootstrap，SSE = 增量。这是 D1 决策（快照端点 + ledger 增量）。

### 4.2 改 `apps/web/src/lib/api.ts`

```ts
// ── 新增类型 ──
export interface MemberInfo {
  memberId: string;
  kind: "agent" | "human";
  agentId?: string | null;
  userRef?: string | null;
  displayName?: string | null;
}
export interface ConversationSnapshot {
  conversationId: string;
  triggerMode: "mention";
  hopCount: number;
  members: MemberInfo[];
}
// ledger SSE entry（绝对事实，content 是 JSON 字符串需二次 parse）
export interface LedgerEntry {
  seq: number;
  conversationId: string;
  senderMemberId: string;
  addressedTo: string[];
  kind: "message" | "member.joined" | "member.left";
  content: string;   // JSON.stringify'd
  ts: number;
}

// ── api 增量 ──
export const api = {
  // ...既有 agents/threads/runs 保留（runs 仍用于 /stream token 细节 + cancel/resume）...

  // Conversations
  getConversation: (id: string) =>
    apiFetch<ConversationSnapshot>(`conversations/${id}`),
  postConversationMessage: (
    id: string,
    body: { senderMemberId: string; addressedTo: string[]; content: unknown },
  ) =>
    apiFetch<{ seq: number; triggeredRuns: Array<{ agentMemberId: string; runId: string }> }>(
      `conversations/${id}/messages`,
      { method: "POST", body },
    ),
};
```

> `getMessages`/`startRun`（thread-binary）从会话页解绑（D3）。`api.cancelRun`/`resumeRun`/`/runs/:id/stream` 仍保留——run 级 token/tool 细节、中断恢复仍按 runId 走（ledger 只到"一条会话消息"粒度，token 流在 event_log）。

### 4.3 改 `apps/web/src/lib/conversation-reducer.ts`（泛化，非重写）

```ts
import type { ContentBlock } from "./api";

export type RunPhase = "idle" | "running" | "interrupted" | "done" | "error";

export interface SenderRef {                    // ★ 替代 role
  memberId: string;
  kind: "agent" | "human" | "system";
  displayName?: string;
}
export interface UiMessage {
  id: string;                                   // "s-<seq>"（权威）| "opt-<n>"（乐观）
  sender: SenderRef;                            // ★ 绝对发送者
  content: string | ContentBlock[];
}
export interface DraftTool { id: string; name: string }
export interface Draft {
  runId: string;
  agentMemberId: string;                        // ★ 哪个 agent 正在出 draft（多 agent 区分）
  sender: SenderRef;                            // 渲染 draft 名牌
  text: string;
  tools: DraftTool[];
}
export interface ConvState {
  viewerMemberId: string;                       // ★ "我"是谁（相对渲染基准）
  roster: Record<string, SenderRef>;            // ★ memberId → SenderRef（从 member.joined/left 重建）
  messages: UiMessage[];
  draft: Draft | null;
  run: { id: string | null; phase: RunPhase; agentMemberId: string | null };
  pendingInterrupt: { id: string; name: string; input: unknown } | null;
  error: string | null;
  optimisticSeq: number;
}

export type Action =
  | { type: "bootstrap"; viewerMemberId: string; members: SenderRef[] }   // ★ 快照注入
  | { type: "ledger/member"; seq: number; kind: "member.joined" | "member.left"; payload: unknown }  // ★ roster 增量
  | { type: "ledger/message"; seq: number; senderMemberId: string; content: unknown }  // ★ 权威消息
  | { type: "send"; text: string; viewer: SenderRef }                     // ★ 乐观，带 viewer
  | { type: "run/started"; runId: string; agentMemberId: string }
  | { type: "stream/delta"; runId: string; agentMemberId: string; blockIndex: number; text: string }
  | { type: "stream/toolStart"; id: string; name: string }
  | { type: "stream/toolEnd"; id: string }
  | { type: "run/interrupted"; payload: { pendingTool?: { id: string; name: string; input: unknown } } }
  | { type: "run/error"; message: string }
  | { type: "run/done" }
  | { type: "run/completed" };

export function initialState(): ConvState {
  return {
    viewerMemberId: "", roster: {}, messages: [], draft: null,
    run: { id: null, phase: "idle", agentMemberId: null },
    pendingInterrupt: null, error: null, optimisticSeq: 0,
  };
}

const norm = (c: unknown): string | ContentBlock[] =>
  typeof c === "string" ? c : (c as ContentBlock[]);

// 权威消息插入：seq 已存在则覆盖；self 覆盖最后一条乐观 self
function upsertAuthoritative(
  list: UiMessage[], id: string, sender: SenderRef,
  content: string | ContentBlock[], viewerMemberId: string,
): UiMessage[] {
  const idx = list.findIndex((m) => m.id === id);
  if (idx >= 0) { const next = [...list]; next[idx] = { id, sender, content }; return next; }
  if (sender.memberId === viewerMemberId) {       // ★ self 覆盖乐观，不再看 role
    const revIdx = [...list].reverse().findIndex(
      (m) => m.id.startsWith("opt-") && m.sender.memberId === viewerMemberId);
    if (revIdx >= 0) {
      const real = list.length - 1 - revIdx;
      const next = [...list]; next[real] = { id, sender, content }; return next;
    }
  }
  return [...list, { id, sender, content }];
}

export function reducer(s: ConvState, a: Action): ConvState {
  switch (a.type) {
    case "bootstrap": {
      const roster: Record<string, SenderRef> = {
        __system__: { memberId: "__system__", kind: "system" },
      };
      for (const m of a.members) roster[m.memberId] = m;
      return { ...s, viewerMemberId: a.viewerMemberId, roster };
    }

    case "ledger/member": {
      // payload.members = 当前全量名册快照（service 每次 append 都带）
      const payload = a.payload as { members?: Array<{ memberId: string; kind: "agent" | "human"; displayName?: string }> };
      const roster = { ...s.roster };
      for (const m of payload.members ?? []) roster[m.memberId] = { ...m };
      // 同时把成员事件作为系统消息进列表（与后端 projectForMember 同语义）
      const id = `s-${a.seq}`;
      const sender: SenderRef = { memberId: "__system__", kind: "system" };
      const verb = a.kind === "member.joined" ? "加入" : "离开";
      const present = (payload.members ?? []).map((m) => roster[m.memberId]?.displayName ?? m.memberId).join(", ");
      const messages = upsertAuthoritative(
        s.messages, id, sender, `[系统] 成员变化：${verb}。当前在场：${present}`, s.viewerMemberId);
      return { ...s, roster, messages };
    }

    case "ledger/message": {
      const id = `s-${a.seq}`;
      const sender = s.roster[a.senderMemberId]
        ?? { memberId: a.senderMemberId, kind: "agent" as const };   // 未知发送者兜底
      const messages = upsertAuthoritative(s.messages, id, sender, norm(a.content), s.viewerMemberId);
      // ★ 自己的权威消息 / 当前 draft 所属 agent 的权威消息到达 → 原子清 draft
      const clearsDraft =
        sender.memberId === s.viewerMemberId ||
        (s.draft && a.senderMemberId === s.draft.agentMemberId);
      return clearsDraft ? { ...s, messages, draft: null } : { ...s, messages };
    }

    case "send": {
      const id = `opt-${s.optimisticSeq}`;
      return { ...s, optimisticSeq: s.optimisticSeq + 1,
               run: { ...s.run, phase: "running" },
               messages: [...s.messages, { id, sender: a.viewer, content: a.text }] };
    }

    case "run/started":
      return { ...s, run: { id: a.runId, phase: "running", agentMemberId: a.agentMemberId }, error: null };

    case "stream/delta": {
      const sender = s.roster[a.agentMemberId] ?? { memberId: a.agentMemberId, kind: "agent" as const };
      return { ...s, draft: {
        runId: a.runId, agentMemberId: a.agentMemberId, sender,
        text: (s.draft?.text ?? "") + a.text, tools: s.draft?.tools ?? [],
      } };
    }

    case "stream/toolStart":
      return s.draft ? { ...s, draft: { ...s.draft, tools: [...s.draft.tools, { id: a.id, name: a.name }] } } : s;
    case "stream/toolEnd":
      return s.draft ? { ...s, draft: { ...s.draft, tools: s.draft.tools.filter((t) => t.id !== a.id) } } : s;

    case "run/interrupted":
      return { ...s, pendingInterrupt: a.payload.pendingTool ?? null,
               run: { ...s.run, phase: "interrupted" }, draft: null };
    case "run/error":
      return { ...s, error: a.message, run: { ...s.run, phase: "error" }, draft: null };

    case "run/done":
    case "run/completed":
      if (s.run.phase === "interrupted" || s.run.phase === "error") return { ...s, draft: null };
      return { ...s, draft: null, run: { ...s.run, phase: "done" } };
  }
}
```

> **消歧点**：`ledger/message` 清 draft 的条件从 M13.2 的"role==assistant"泛化为"sender 是 viewer **或** sender 是当前 draft 所属 agent"——多 agent 下每个 agent 的权威到达只清自己的 draft，互不干扰。`upsertAuthoritative` 的乐观替换从"role==user"泛化为"sender.memberId == viewerMemberId"。

### 4.4 改 `apps/web/src/hooks/useConversation.ts`

签名从 `(threadId, initialRun)` 改为 `(conversationId)`，数据源切到 ledger SSE：

```ts
export function useConversation(conversationId: string) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const qc = useQueryClient();

  // 1) 快照 bootstrap（roster + viewerMemberId）
  const snap = useQuery({ queryKey: ["conv", conversationId], queryFn: () => api.getConversation(conversationId) });
  useEffect(() => {
    if (!snap.data) return;
    const members: SenderRef[] = snap.data.members.map((m) => ({
      memberId: m.memberId, kind: m.kind, displayName: m.displayName ?? undefined }));
    const viewerMemberId = members.filter((m) => m.kind === "human")[0]?.memberId ?? "";  // D2
    dispatch({ type: "bootstrap", viewerMemberId, members });
  }, [snap.data]);

  // 2) conversation ledger SSE（一条流：消息 + 成员事件 + 系统消息）
  useEffect(() => {
    if (!conversationId) return;
    const es = new EventSource(`/api/bff/conversations/${conversationId}/events`);
    const seen = new Set<number>();
    const guard = (e: MessageEvent) => {
      const seq = parseInt(e.lastEventId, 10);
      if (Number.isFinite(seq)) { if (seen.has(seq)) return null; seen.add(seq); }
      return seq;
    };
    es.addEventListener("message", (e) => {           // event 名 = ledger entry.kind
      const seq = guard(e as MessageEvent); if (seq === null) return;
      const entry = JSON.parse((e as MessageEvent).data);
      const content = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
      if (entry.senderMemberId === "__system__")
        dispatch({ type: "ledger/member", seq, kind: "member.joined", payload: content });  // 系统普通消息也走系统条
      else
        dispatch({ type: "ledger/message", seq, senderMemberId: entry.senderMemberId, content });
    });
    for (const k of ["member.joined", "member.left"] as const)
      es.addEventListener(k, (e) => {
        const seq = guard(e as MessageEvent); if (seq === null) return;
        const entry = JSON.parse((e as MessageEvent).data);
        const payload = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
        dispatch({ type: "ledger/member", seq, kind: k, payload });
      });
    return () => es.close();
  }, [conversationId]);

  // 3) run 级 token/tool 细节：仅当有活跃 run 时订阅 /runs/:id/stream（draft 用）
  useEffect(() => {
    const runId = state.run.id;
    if (!runId || state.run.phase !== "running") return;
    const agentMemberId = state.run.agentMemberId ?? "";
    const es = new EventSource(`/api/bff/runs/${runId}/stream`);
    es.addEventListener("text_delta", (e) => {
      const { blockIndex, text } = JSON.parse((e as MessageEvent).data);
      if (typeof text === "string") dispatch({ type: "stream/delta", runId, agentMemberId, blockIndex, text });
    });
    es.addEventListener("tool_start", (e) => {
      const { id, name } = JSON.parse((e as MessageEvent).data);
      if (id && name) dispatch({ type: "stream/toolStart", id, name });
    });
    es.addEventListener("tool_end", (e) => {
      const { id } = JSON.parse((e as MessageEvent).data);
      if (id) dispatch({ type: "stream/toolEnd", id });
    });
    return () => es.close();
  }, [state.run.id, state.run.phase, state.run.agentMemberId]);

  // 4) 发送：postMessage → 用返回的 triggeredRuns[0] 接管 run（订阅 /stream）
  const sendMut = useMutation({
    mutationFn: (text: string) => api.postConversationMessage(conversationId, {
      senderMemberId: state.viewerMemberId,
      addressedTo: resolveAddressedTo(state),       // 单 agent 退化 = 唯一 agent member
      content: text,
    }),
    onSuccess: (d) => {
      const tr = d.triggeredRuns[0];
      if (tr) dispatch({ type: "run/started", runId: tr.runId, agentMemberId: tr.agentMemberId });
    },
    onError: () => dispatch({ type: "run/error", message: "发送失败" }),
  });
  const send = useCallback((text: string) => {
    const viewer = state.roster[state.viewerMemberId] ?? { memberId: state.viewerMemberId, kind: "human" as const };
    dispatch({ type: "send", text, viewer });
    sendMut.mutate(text);
  }, [sendMut, state.roster, state.viewerMemberId]);

  // resume/cancel 仍按 runId（run 级中断恢复，ledger 不涉及）
  const resumeRun = useMutation({ mutationFn: (v: { approved: boolean; message?: string }) =>
    api.resumeRun(state.run.id!, v.approved, v.message) });
  const cancelRun = useMutation({ mutationFn: () => api.cancelRun(state.run.id!) });

  return {
    viewerMemberId: state.viewerMemberId, roster: state.roster,
    messages: state.messages, draft: state.draft, phase: state.run.phase,
    busy: state.run.phase === "running" || (!!state.draft && state.run.phase !== "done"),
    pendingInterrupt: state.pendingInterrupt, error: state.error,
    runId: state.run.id, loading: snap.isLoading, send,
    approve: (m?: string) => resumeRun.mutate({ approved: true, message: m }),
    deny: (m?: string) => resumeRun.mutate({ approved: false, message: m }),
    cancel: () => cancelRun.mutate(), canceling: cancelRun.isPending, resuming: resumeRun.isPending,
  };
}

function resolveAddressedTo(s: ConvState): string[] {
  const agents = Object.values(s.roster).filter((m) => m.kind === "agent");
  return agents.length === 1 ? [agents[0]!.memberId] : [];  // 单 agent 退化；多 agent 由 UI @ 选择（M14 内只支持单 agent 自动）
}
```

> `safeParse` = `try JSON.parse catch raw`。`/runs/:id/stream` 仍是 ephemeral text_delta/tool；`/runs/:id/events`（done/interrupted 权威）的角色由 ledger SSE 接管——`run/done` 改由"ledger 收到该 agent 的权威消息 + triggeredRuns 已落地"驱动，或保留一个对 `/runs/:id/events` 的 done 监听作兜底（落地时二选一，建议保留 done 监听最小改动）。

### 4.5 改 `components/Timeline.tsx` + `MessageBubble`

```tsx
export function Timeline({ messages, viewerMemberId }: { messages: UiMessage[]; viewerMemberId: string }) {
  return (
    <div className="max-w-3xl mx-auto">
      {messages.map((m) => {
        const isSelf = m.sender.memberId === viewerMemberId;
        const isSystem = m.sender.kind === "system";
        if (isSystem)
          return <SystemNotice key={m.id} text={typeof m.content === "string" ? m.content : ""} />;
        const text = typeof m.content === "string" ? m.content : extractText(m.content);
        return (
          <div key={m.id}>
            {text && (
              <MessageBubble
                align={isSelf ? "right" : "left"}
                name={isSelf ? undefined : (m.sender.displayName ?? m.sender.memberId)}
                kind={m.sender.kind}
                content={text}
              />
            )}
            {typeof m.content !== "string" && renderContentBlocks(m.content)}
          </div>
        );
      })}
    </div>
  );
}
```

> `MessageBubble` 的 `role: "user"|"assistant"` props 改为 `align: "left"|"right"` + 可选 `name` + `kind`。self → 右、无名牌（旧 You 外观）；other → 左、带名牌、按 `kind` 区分 agent/human 配色。这是"self 是相对渲染量"的唯一落点。

### 4.6 改 `components/ConversationCanvas.tsx` + draft

- 接线换 `useConversation(conversationId)`；`<Timeline messages viewerMemberId>`；`{draft && <DraftMessage draft={draft} />}`（DraftMessage 用 `draft.sender.displayName` 渲染 agent 名牌）。
- 路由：会话页 URL 参数从 `threadId` 改 `conversationId`（退化场景 `conversationId === threadId`，backfill 保证，路由层零困扰）。
- 侧边栏新增成员名册（`roster` 渲染头像列表，[14-conversation §八](../../architecture/14-conversation.md) 的 web 映射）。

### 4.7 成员管理 UX —— agent 如何加入/离开会话

后端原语已具备：`POST /conversations/:id/members {memberId, kind, agentId, displayName}`（加）/ `{memberId}`（删）。M14 暴露**最小可用**入口：侧边栏 roster 底部 "+ 添加 agent"。

关键约束：`AgentMember.agentId` 指向 agentStore，一个 agent 实体可被多会话复用（[14-conversation §二](../../architecture/14-conversation.md)）。所以"加入会话"= 从已有 agent 列表挑一个注册成 member，**不是新建 agent**，与 IM "拉人进群" 同构。

```tsx
function AddMemberButton({ conversationId, roster, onAdded }: {
  conversationId: string; roster: Record<string, SenderRef>; onAdded: () => void;
}) {
  const { data: agents } = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const present = new Set(Object.values(roster).filter((m) => m.kind === "agent").map((m) => m.memberId));
  const add = useMutation({
    mutationFn: (a: AgentRow) => api.addConversationMember(conversationId, {
      memberId: `agent-${a.id}`,            // 退化命名，稳定可推导
      kind: "agent", agentId: a.id, displayName: a.name,
    }),
    onSuccess: onAdded,                       // SSE 推 member.joined → roster 自动更新；此处仅关弹窗
  });
  // 渲染：agents 排除 present（已在场置灰）→ 点击 add.mutate(agent)
}
```

`api.ts` 配套：

```ts
addConversationMember: (id: string, body: {
  memberId: string; kind: "agent" | "human"; agentId?: string; displayName?: string;
}) => apiFetch<{ members: MemberInfo[] }>(`conversations/${id}/members`, { method: "POST", body }),
removeConversationMember: (id: string, memberId: string) =>
  apiFetch<{ members: MemberInfo[] }>(`conversations/${id}/members`, { method: "POST", body: { memberId } }),
```

加入闭环**全靠现有机制零额外逻辑**：`POST /members` → service 写 ledger `member.joined` → SSE 推 → reducer `ledger/member` 更新 roster + 落系统条。离开对称：roster 每个 agent 旁 "移除" → `removeConversationMember` → `member.left`。

> **不变量：viewer（唯一 human）不可被移除** —— 否则 `viewerMemberId` 解析失败、会话失去发送主体。UI 禁用 human member 的移除按钮。

### 4.8 删除项

- 删会话页对 `api.getMessages` / `api.startRun`（thread-binary）的依赖（D3 不并存）
- 删 `useConversation` 旧 `history/loaded`（thread messages）分支、`getCurrentRun` poll（ledger SSE 已是权威源；如需兜底改订阅 `/runs/:id/events` done）
- 全局 grep 确认无残留：`getMessages(` 在会话页、`role: "user"` 字面 self 判断、`UiMessage.role`

---

## 五、不变量（invariant）

- **ledger 只存绝对 `senderMemberId`，从不存 "self"** — self 是 surface 侧 `senderMemberId === viewerMemberId` 的派生量
- **conversation 模型无固定 "You" role** — `UiMessage.sender: SenderRef`，渲染期才解出 self/other
- **viewerMemberId 由 web surface 解析**（D2：取唯一 human member），backend 无 per-user 身份
- **跨 surface 同一人 = userRef→identity 解析，非 memberId 合并** — M14/M15 不合并，未来由 `identityRef` 承接
- **传输只走绝对 memberId** — `kind`/`displayName` 前端从 roster 重建，不进 POST body
- **后端协作语义零改动** — 唯一后端变更是只读 `GET /conversations/:id` 快照；service/ledger/广播/安全阀不变
- **降级等价** — 单 agent + 单真人 = M13.2 两栏视觉；`conversationId === threadId`（backfill）
- **draft 归属 agentMemberId** — 多 agent 各自 draft，权威到达只清自己的（M13.2 单 draft 互斥的多 agent 泛化）

---

## 六、测试要求（reducer fixture 驱动）

- [ ] `bootstrap` 后 `viewerMemberId` = 唯一 human；roster 含 `__system__`
- [ ] self 的乐观消息被同 memberId 的权威 `ledger/message` 覆盖，不重复（泛化自 M13.2 乐观 user 用例）
- [ ] other（agent）的 `ledger/message` 渲染 sender.kind=agent，不覆盖乐观
- [ ] `stream/delta` 累积后，**同 agentMemberId** 的权威 `ledger/message` 到达 → 清该 draft；**异 agentMemberId** 权威到达不清当前 draft
- [ ] 多 agent：A 的 draft 进行中，B 的权威消息到达 → A 的 draft 保留
- [ ] `member.joined`/`member.left` 更新 roster 全量快照 + 落一条系统条
- [ ] 单 agent 退化：`resolveAddressedTo` 返回唯一 agent memberId；视觉等价 M13.2
- [ ] `run/done` 与 `run/completed` 双触发幂等；interrupted/error 不被覆盖为 done
- [ ] 未知 senderMemberId（不在 roster）兜底为 agent kind，不崩

---

## 七、CI Gate

```sh
bun run format && bun run lint && bun run typecheck && bun run test && bun run build
```

---

## 八、Commit 计划

| # | Commit | 内容 |
|---|---|---|
| 1 | `feat(backend): GET /conversations/:id read-only snapshot` | http.ts snapshot handler + router 路由 + test |
| 2 | `feat(web): generalize reducer to SenderRef — self as relative render` | `conversation-reducer.ts` role→sender + roster + viewerMemberId + 全套 fixture |
| 3 | `feat(web): useConversation consumes ledger SSE + snapshot bootstrap` | hook 换数据源到 `/conversations/:id/events` + `getConversation` |
| 4 | `refactor(web): Timeline/MessageBubble render self/other by viewer` | align/name/kind 渲染，删 role 二元 |
| 5 | `refactor(web): ConversationCanvas + routing conversation-first; roster sidebar` | 接线 + 侧边栏名册 + 路由 conversationId |
| 6 | `feat(web): member roster add/remove UX (AddMemberButton)` | 成员加/删 UX + api 封装 + viewer 不可移除 |
| 7 | `chore(web): drop thread-binary path (getMessages/startRun/currentRun poll)` | 删旧路径，grep 确认无残留 |

---

## 九、验收清单

- [ ] CI 全绿
- [ ] 单 agent 会话视觉与行为与 M13.2 完全一致（降级等价）
- [ ] 会话页数据源为 `/conversations/:id/events`，无 `/threads/:id/messages` 调用
- [ ] self 渲染由 `senderMemberId === viewerMemberId` 派生，无 `role: "user"` 字面 self 判断
- [ ] 成员名册侧边栏从 roster 渲染；member.joined/left 实时更新
- [ ] reducer fixture 全覆盖第六节清单
- [ ] 后端仅新增只读快照端点，协作语义零改动
- [ ] 无跨 surface 身份合并逻辑（IM/IdP 留 M15+）

---

## 十、产品链路分层能力盘点（M14 体检）

从"真人在统一空间装配并管理 agent team"这条产品链路反推，各层能力现状与缺口：

### L5 Backend —— conversation 写链路全通，读链路有洞

**已具备**：建会话 / 加删成员 / 发消息（@触发 fork run）/ SSE 事件流（afterSeq + Last-Event-ID 续读）；ledger seq 由 SQLite AUTOINCREMENT 保证单调；三表 schema + 迁移齐全；旧 thread→退化会话 backfill 幂等且单 agent 退化打通（`resolveLegacyThreadRun` 把 `POST /threads/:id/runs` 转发到会话）；run 正常生命周期（succeeded/error/aborted + heartbeat 超时）均 fire `completeRun` 释放锁。

| 缺口 | 严重 | 文件 | 方向 |
|---|---|---|---|
| **读取类端点缺失**：无 `GET /conversations`（列表）、`GET /conversations/:id`（快照）、`GET .../members` | **阻塞 M14** | `http.ts`/`router.ts` | M14 §4.1 已规划 snapshot；列表端点需补（会话列表页依赖） |
| **重启后悬挂锁**：`activeConversations` 是纯内存 Set，backend 重启清空，`rediscover()` 只重建 run 不重建会话锁；且 `cancel()` 死进程分支不 fire `onRunComplete` | **阻塞 M14 多 agent** | `main.ts`、`supervisor.ts` | rediscover 按 running run 的 threadId 反推 cid 重填锁；cancel 死进程分支补 fire |
| 会话管理端点（改标题 PATCH / 删除归档 DELETE）+ `title`/`archived_at` 字段 | M14 后可补 | `http.ts` + schema | 加端点 + 迁移 |
| 无"从 agent 创建会话"便捷端点 | M14 后可补 | `http.ts` | `POST /agents/:id/conversations` 封装 create+addMember |
| 鉴权无多租户隔离：全局单 token，所有会话对持 token 者全局可见 | 长期（M14 需知晓） | `auth.ts` | 与 §三.3 身份系统一并演进 |

### L6 Web —— 数据/状态/发送者模型三处需建（M14 主体）

**已具备**（在 origin/next，M13.2 已落地）：单 reducer + 至多一条 draft（`conversation-reducer.ts`）；`ConversationCanvas`/`Timeline`/`DraftMessage`/`MessageBubble`；中断审批 `ToolApprovalCard`+`resumeRun`；BFF 通配代理（新端点零成本可达）；HMAC cookie 鉴权。**M14 缺口正是本 spec §四主体**：conversation 端点封装、reducer 泛化（role→sender）、发送者模型、成员名册侧栏、@mention、新建会话入口。

> ✅ **工程状态（已处理）**：本地已 `git checkout origin/next`（@ `30b12e6`）并建分支 `m14-web-conversation`，M13.1/M13.2 全部产物（`conversation-reducer.ts`、`ConversationCanvas`、`DraftMessage` 等）已在工作区。§4.0 的对齐基线即基于此次 checkout 后的真实代码核对。

### L1–L4 —— conversation 不渗透，符合分层铁律

[14-conversation §五](../../architecture/14-conversation.md) 的核心纪律是"协作语义停在 backend 层，绝不下沉到 framework/harness/runner；agent 子进程只认 checkpointer、不认识 ledger/conversation"。所以 L1–L4 **本就不该有 conversation 概念**——member 事件通过广播投影成 `thread.messages`（§三.4），framework 层只看到普通 user/assistant 消息。**这不是缺口，是设计正确性**：M14 是纯 L5+L6 的工作，L1–L4 零改动验证了"叠加而非侵入"。

### 跨层遗漏：vision 文档与实现漂移

[00-vision §五](../../architecture/00-vision.md) 的 milestone 表仍写 "M10=Member/Conversation 待定、M13=web、M14=IM bot"，但实际：conversation 后端已落地（M10 已做）、web 已到 M13.2、当前 M14=web conversation 化、IM 顺延 M15。**vision milestone 表需校准**（建议本 spec 落地后单独更新 vision，不混入 M14 代码 commit）。

---

**Spec 结束。**
