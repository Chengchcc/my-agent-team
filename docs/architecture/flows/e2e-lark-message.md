---
id: flows.e2e-lark-message
title: 飞书消息端到端
status: current
owners: architecture
last_verified_against_code: 2026-06-25
summary: "飞书消息的完整生命周期：飞书用户发消息 → lark-bot 解析绑定、POST 到 Backend → AgentSession 执行 → onEvent 回调写 conversation ledger → sse-watcher 解析 revision → 去重推送到飞书。"
depends_on:
  - surfaces.lark-adapter
  - backend.conversation-projection
used_by:
---

# 飞书消息端到端

飞书用户发消息后，lark-bot 作为中继：解析飞书 chat 绑定，将消息 POST 到 Backend 的 conversation API，Backend 通过 AgentSession 执行 Agent，assistant 消息写入 conversation ledger。lark-bot 的 sse-watcher 监听账本 SSE，解析 MessageRevision，去重后推送到飞书。

## 时序图

```mermaid
sequenceDiagram
  participant U as 飞书用户
  participant Bot as 飞书 Bot
  participant B as Backend
  participant AS as AgentSession
  participant L as Conversation Ledger

  U->>Bot: 发消息 / @机器人
  Bot->>B: 解析 chat 绑定（无则新建 Conversation + 成员）
  Bot->>B: POST /api/conversations/:id/messages
  B->>L: 写入人类 MessageRevision
  B->>AS: startAgentRun(input) → 创建 AgentSession
  AS->>AS: ConversationContextPlugin.beforeModel（surface=lark，含 start_new_conversation 工具）
  AS->>AS: agent.run() + agent.continue()（多轮）
  AS-->>B: onEvent("message")
  B->>L: appendAssistantMessage（state: streaming）
  L-->>Bot: 账本 SSE → sse-watcher 解析 revision
  Bot->>Bot: state=streaming → 渲染流式文本
  AS-->>B: onEvent("message")（更多轮 → 同 messageId 更新）
  B->>L: 同 messageId 直写
  L-->>Bot: 账本 SSE → 同 messageId 更新
  AS-->>B: onEvent("agent_end", willRetry: false)
  B->>L: terminal revision（state: done）
  L-->>Bot: 账本 SSE → revision（同 messageId, state: done）
  Bot->>Bot: canSkipFinalLedgerText 去重判断
  Bot->>U: 推送最终文本
```

## 绑定模型

飞书适配器维护四组映射：飞书 chat → conversationId；飞书 user → human member；Bot/Agent 身份 → agent member；飞书消息 ID → 投递状态。

## 流式输出

sse-watcher 是飞书端唯一出站流入口。它监听 conversation SSE，解析 MessageRevision。`state: "streaming"` 的 revision 驱动实时流式渲染，`state: "done"` 的 revision 触发最终文本推送。

## 去重模型

同一个 `messageId` 的多次 revision（streaming → done）可能从两条路径到达飞书：流式渲染路径和 terminal revision 路径。去重依赖 `messageId` 和 `canSkipFinalLedgerText` 标记：首次 terminal revision 到达时推送最终文本，后续重连重放时跳过。

## surface.control — 对话重置

Agent 可调用 `start_new_conversation` 工具请求开启新对话。Backend 创建新的 Conversation，在旧 conversation 的 ledger 中写入 `surface.control` entry。sse-watcher 检测到此 entry，将飞书 chat 重新绑定到新 conversation。

## 出问题先看哪层

| 症状 | 可能成因 | 接着读 |
|---|---|---|
| 最终答案重复 | terminal revision 重放 / 去重未命中 | [飞书适配器](../surfaces/lark-adapter.md) |
| 流式输出不更新 | conversation SSE 断连 | [会话消息流](../backend/conversation-projection.md) |
| Agent 没触发 | 绑定/成员/提及问题 | [对话与成员](../conversation/conversation-and-members.md) |

## 关联页面

- [飞书适配器](../surfaces/lark-adapter.md)
- [会话消息流](../backend/conversation-projection.md)
- [对话与成员](../conversation/conversation-and-members.md)
- [排障手册](../operations/troubleshooting.md)
