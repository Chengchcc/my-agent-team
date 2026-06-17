# @my-agent-team/conversation

对话领域模型的唯一本体。定义 Member（参与者身份）、Conversation（对话聚合）、LedgerEntry（账本条目的 zod schema + 类型）、projectForMember（成员视角投影），以及 resolveTriggerTargets（触发解析）。纯 Zod schema 加无状态辅助函数。

## 为什么它是一个独立包（尽管只有 ~220 行）

`conversation` 的领域类型被三个独立 app 跨端共享：

| 消费者 | 用途 |
|--------|------|
| `apps/backend` | 账本存储、会话投影、广播 |
| `apps/web` | 前端 reducer、SSE 解析、UI 渲染 |
| `apps/lark-bot` | SSE 监听、飞书消息投递 |

如果把它塞进任一 app，另两个 app 就得各自复制一份 Member/LedgerEntry 的 zod schema 和投影逻辑——这正是之前 `LedgerEntry` 有三份手抄同形定义（backend `LedgerRow`、lark `LedgerEntry` interface、web `SenderRef`）的根源。它不是"因为有概念所以建包"——它是"因为有跨端共享的客观需求所以必须独立"。

判据（对照 `design-philosophy.md` §3.5）：**包是依赖边界，不是文件抽屉。** `agent-spec` 只有单一消费者（`runner-daemon`）→ 该并回去。`conversation` 有三个跨端消费者 → 必须独立。

## 核心概念

**Member。** 基于 `kind` 的判别联合：`AgentMember`（`kind: "agent"`）和 `HumanMember`（`kind: "human"`）。注意 `Member` 是**会话参与者身份**，与 `packages/message` 的 `MessageAuthor`（消息作者角色：system/user/agent/tool）不同层。

**Conversation。** 对话聚合：`conversationId`、`members`、`triggerMode`（`"mention" | "all"`，默认 `"mention"`）、`createdAt`。

**LedgerEntry。** 账本条目的 zod schema，是对话消息的**唯一规范本体**（后端 `LedgerRow`、lark 本地 `LedgerEntry` 手抄已删除）：

```ts
{
  seq: number; conversationId: string; senderMemberId: string;
  addressedTo: string[];
  kind: "message" | "member.joined" | "member.left" | "todo" | "surface.control";
  content: string;   // JSON 字符串
  ts: number;
  runId?: string;    // 追溯消息到运行，assistant 消息写入时携带
}
```

`runId` 是领域本体字段（不是存储行附属），使消息可追溯到产出它的运行。

**投影（projectForMember）。** `projectForMember(entry, viewerMemberId, conv)` → `{ role, text }`。规则：
- 自己发的 → `assistant` 角色，无前缀
- `__system__` 发的 → `user` 角色，加 `[系统]` 前缀；`member.joined`/`member.left` 渲染成可读的成员变化说明
- 其他成员发的 → `user` 角色，前缀 `[displayName]: `

**触发解析（resolveTriggerTargets）。** 把 `addressedTo` 解析成 `AgentMember[]`。

**断言辅助。** `assertMember`（抛 `MemberNotFoundError`）、`assertAgentMember`（抛 `NotAgentMemberError`）。

## 怎么用

```ts
import { projectForMember, resolveTriggerTargets } from "@my-agent-team/conversation";
import type { Conversation, LedgerEntry, Member } from "@my-agent-team/conversation";

declare const conv: Conversation;
declare const entry: LedgerEntry;

const view = projectForMember(entry, "member-bot", conv);
const targets = resolveTriggerTargets(conv, entry.addressedTo);
```

## 依赖关系

`conversation` 依赖 `zod` + `@my-agent-team/message`（re-export messageId 工厂、codec、谓词供消费者统一 import）。被 `apps/backend`、`apps/web`、`apps/lark-bot` 三个 app 跨端依赖。
