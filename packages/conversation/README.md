# @my-agent-team/conversation

定义多 agent 对话的领域模型：谁在对话里、消息怎么寻址、以及如何把一条共享账本记录投影成某个成员视角下的 LLM 可见消息。纯 Zod schema 加无状态辅助函数，除 `zod` 外没有运行时依赖。

## 为什么需要它

单 agent 场景下，"消息列表"就够用了。但多个 agent 和人类共处一个对话时，会冒出几个新问题：成员是谁、各是什么身份；一条消息发给谁（寻址）；以及——这是最关键的——同一份对话历史，在不同成员眼里应该长得不一样。自己发的话是 `assistant`，别人发的话是带名字前缀的 `user`，系统通知又是另一种样子。把这套规则散落在后端各处会很容易写错。这个包把对话的领域词汇和投影规则集中固化下来，让后端只负责调用，不必重新发明。它有意保持纯粹：schema 描述数据形状，辅助函数都是确定性的、无副作用的。

## 核心概念

**Member。** 成员是基于 `kind` 的判别联合，两种：`AgentMember`（`kind: "agent"`，带 `memberId`、`agentId`、可选 `displayName`）和 `HumanMember`（`kind: "human"`，带 `memberId`、`userRef`、可选 `displayName`）。

**Conversation。** 对话聚合，包含 `conversationId`、一组 `members`（至少一个）、`triggerMode` 和 `createdAt`。`TriggerMode` 是 `z.enum(["mention", "all"])`，默认 `"mention"`——它决定没有被点名的 agent 要不要也响应。

**LedgerEntry。** 账本是一条条追加写入的记录。每条带 `seq`（序号）、`conversationId`、`senderMemberId`（谁发的）、`addressedTo`（发给哪些成员 id，默认空数组）、`kind`（`"message" | "member.joined" | "member.left"`）、`content` 和 `ts`。账本是对话的事实来源，但它不是任何单个成员"看到"的东西——成员看到的是投影后的结果。

**投影（projectForMember）。** 这是本包的核心动作：`projectForMember(entry, viewerMemberId, conv)` 把一条账本记录转成 `{ role: "user" | "assistant", text }`。规则是：
- 自己发的消息（`senderMemberId === viewerMemberId`）→ `assistant` 角色，无前缀。
- 系统消息（`senderMemberId === "__system__"`）→ `user` 角色，加 `[系统]` 前缀；其中 `member.joined`/`member.left` 会渲染成一句可读的成员变化说明，形如 `[系统] 成员变化：某某 加入。当前在场：...`，名字取自各成员的 `displayName`。
- 其他成员发的消息 → `user` 角色，前缀是 `[displayName]: `（即方括号里成员显示名，后跟冒号空格）。

**触发解析（resolveTriggerTargets）。** `resolveTriggerTargets(conv, addressedTo)` 把一组被寻址的 id 解析成应当接下来运行的 `AgentMember[]`——只保留确实存在且 `kind` 为 `agent` 的成员。

**断言辅助。** `assertMember(conv, memberId)` 找不到成员时抛 `MemberNotFoundError`；`assertAgentMember(conv, memberId)` 在此基础上要求成员必须是 agent，否则抛 `NotAgentMemberError`。两个错误类都对外导出。

## 怎么用

```ts
import {
  projectForMember,
  resolveTriggerTargets,
} from "@my-agent-team/conversation";
import type { Conversation, LedgerEntry } from "@my-agent-team/conversation";

declare const conv: Conversation;
declare const entry: LedgerEntry;

// 把账本记录投影成某个 agent 成员视角下的消息
const view = projectForMember(entry, "member-bot", conv);
// 别人的消息 → { role: "user", text: "[Alice]: ship it" }

// 解析这条记录应该触发哪些 agent 继续运行
const targets = resolveTriggerTargets(conv, entry.addressedTo);
// → AgentMember[]
```

## 依赖关系

`conversation` 只依赖 `zod`，被 `apps/backend` 依赖（后端用它做对话存储与账本投影）。
