---
title: 环境规则（Ambient Rules）
description: 群聊未点名消息如何被操作者写的规则升格为任务：observe 缝、record/act 两档、proactive_event 台账
tags: [backend, lark, proactive]
---

# 环境规则（Ambient Rules）

本页是 ADR 0046 环境规则的权威描述：一条**未被点名**的群聊消息，在什么条件下会被操作者写的规则升格为 agent 任务，以及这件事的台账记在哪。

## 范围

覆盖：规则配置的形状与语义、observe 缝的评估时机、record/act 两档的行为、`proactive_event` 台账、HTTP 面、边界与不评估的情形。

不覆盖：飞书端的准入三层（群准入/发送者白名单/@ 判定，见 [飞书](../surfaces/lark.md)）、Agent Run 自身的生命周期（见 [Product Backend 总览](./overview.md)）、决策来龙去脉（见 [ADR 0046](../../adr/0046-ambient-rules-proactive-spine.md)）。

## 实现文件

- `apps/backend/src/features/proactive/domain.ts` — 纯函数：`matchAmbientRule`（first-match-wins）、`frameAmbientInput`（任务框定）
- `apps/backend/src/features/proactive/service.ts` — 评估入口：读 agent 配置 → 匹配 → 先落事件再决定
- `apps/backend/src/features/proactive/adapter-sqlite.ts` — `proactive_event` 表读写
- `apps/backend/src/features/proactive/http.ts` — `GET /api/proactive/events`
- `apps/backend/src/features/conversation/service.ts` — observe 缝：`postMessage` 在路由为空时调用注入的 `evaluateAmbient`
- `apps/backend/src/features/agent/agent-config.ts` — `lark.ambient.rules` 的 schema、构建与 agent.yml 序列化
- `apps/lark-bot/src/ingest.ts` — 消息 POST 携带 `source: { kind: "lark", chatId }`
- `apps/backend/src/bootstrap/features.ts` — 组装：proactive service → conversation 的 `evaluateAmbient`

## 规则配置

规则存在 agent 配置的 `lark.ambient.rules`（agent.yml 是唯一真源，与 allowed_senders 同信任模型），经 `POST/PATCH /api/agents` 的 `lark.ambientRules` 读写（替换语义，同 `groups`）。每条规则：

| 字段 | 语义 |
|---|---|
| `id` | 规则名，进事件台账与任务框定文本 |
| `chats` | Lark chat id 列表；**空 = 所有被准入且被观察的群** |
| `senders` | open_id 列表（同 allowed_senders 词汇）；空 = 任何已准入发送者 |
| `keyword` | 对消息文本的**大小写不敏感子串**匹配；故意不做正则 |
| `mode` | `record`（只记"本可以做什么"）或 `act`（升格为任务） |
| `instruction` | act 必填（配置期校验拒绝空指令的 act 规则）；给 agent 的任务框定 |

数组顺序即优先级：**first-match-wins**，窄规则排在宽规则前面。

## observe 缝

群聊里未被 @ 的消息本来就会以 `addressedTo: []` POST 进会话账本（只记上下文、不触发 run）。环境规则评估就挂在这条缝上：

1. `postMessage` 用成员路由解析出 targets；
2. **targets 为空**、输入带 `source`（lark-bot 现在每条消息都带）、会话**单成员**、content 是**纯文本**时，调用 `evaluateAmbient`；
3. 无规则命中 → 维持 observe（不写任何行）；
4. 命中 record 规则 → 落一条 `proactive_event`（outcome `recorded`），消息维持 observe；
5. 命中 act 规则 → **先落事件**（outcome `triggered`），再把消息改写为 `frameAmbientInput`（instruction + 原文逐字引用）并按被点名处理——入队、run、卡片、审批、回复全部走既有链路，没有第二条执行身份。

任何失败（配置读不出、事件写不进、评估器抛错）都降级为"未命中"：观察消息照常落账本，绝不多触发，也绝不丢。

## 台账与读模型

`proactive_event` 每次规则**命中**一行（不是每条观察消息一行）：id、ts、agent、会话、规则、mode、outcome、chat、发送者、消息前 200 字符。没有到 conversation 的外键——审计事实要比会话活得久。读模型 `GET /api/proactive/events?agentId=&limit=`（默认 50、上限 200，新在前）。

## 不变量

1. 评估只发生在自然路由为空的输入上；被点名/单聊的触发路径不受影响。
2. act 触发的 run 与被点名的 run 走同一条 enqueueAndAcquire 链路。
3. act 不落事件 = 不触发（事件写失败取消升格）。
4. 评估失败 ≠ 消息失败。

## 已知边界

- 多成员会话不评估（room 的语义是显式点名）。
- 带图片的 ContentBlock[] 输入不参与（子串匹配没有对象）。
- 私聊永不 observe（ADR 0034），所以环境规则实际只在群里生效。
- Web 面板（规则编辑 + 事件流）与模型辅助匹配、GitHub 来源都还没做，见 [roadmap](../../roadmap.md)。
