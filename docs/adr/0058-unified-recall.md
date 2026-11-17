# ADR 0058: 一个召回入口，四个源

- 状态: Implemented
- 日期: 2026-11-17
- 相关: ADR 0055（记忆检索）、ADR 0056（选人即能力召回）

## 背景

"哪些东西是我知道的"这个问题，之前有三套答案、三种形状：

| 调用点 | 形状 | 位置 |
|---|---|---|
| 派发前的上下文召回 | `collectRecall` → `{hits, searched}` | 后端 |
| 选工人 | `recallWorkers` → `{hits, considered, excluded}` | 后端 |
| 记忆 / 技能 | `recall` 工具、技能描述匹配 | **子进程** |

修召回质量时，先得知道自己在修哪一个。

## 决策

### D1 一套词汇，一个函数

```ts
recall(ports, { sources, conversationId?, text?, brief?, limit? })
  → { hits, searched, skipped }
```

`RecallHit` 统一带 `source / ref / at / text / why / score? / meta?`。
`source` 是枚举：`history | qa | capability | memory | skill`。

后端真正能答的三个源（history / qa / capability）在 `features/recall` 里各有一个适配段；选工人也走这里——取 `capability` 命中的第一条，用 `meta.agentId`。

### D2 答不了的源要报 `skipped`，不能静默为空

`memory` 与 `skill` 住在 run 的子进程里（oma 的记忆工具、技能包），后端够不到。**本 ADR 不搬代码跨进程**，但要求它们出现在 `skipped` 里并带原因：

```
skipped: [
  { source: "memory", reason: "lives in the run's process (oma memory tool)" },
  { source: "skill",  reason: "lives in the run's process (skill packs)" },
]
```

理由和 ADR 0055 的那条一样：**"没有"和"没查"必须可区分**。空的 `hits` 加一条 `skipped` 才会被读成"这件事我查不到"，而不是"这件事不存在"。

### D3 `searched` 区分"查过没有"与"查了没有"

- 没有线索 → `{source: "history", hits: 0, detail: "no reference cues — not searched"}`
- 缺端口/作用域 → 进 `skipped`（这是配置问题，不是结果）
- 查了没中 → `{hits: 0, detail: "this conversation's ledger"}`

三种在渲染层是三种不同的句子。

### D4 上限由调用方给

`limit` 缺省 6。早先的实现里有一处 `Math.max(limit, 6)`，等于把调用方的 2 悄悄放大成 6——已删。

## 落点

| 文件 | 改动 |
|---|---|
| `apps/backend/src/features/recall/domain.ts`（新） | `RecallSource` / `RecallHit` / `RecallResult` / `RecallRequest` |
| `apps/backend/src/features/recall/cues.ts`（新） | 线索抽取从 `agent-run/recall.ts` 迁出（无循环依赖） |
| `apps/backend/src/features/recall/recall.ts`（新） | 扇出 qa / history / capability；`skipped` 语义 |
| `apps/backend/src/features/agent-run/recall.ts` | 只留 `collectRecall`（薄封装）+ 渲染 + 槽位证据；类型从新模块 re-export |
| `apps/backend/src/bootstrap/features.ts` | `pickAgent` 改走 `recall({sources:["capability"]})`，取 `meta.agentId` |

## 验证

- capability 命中带 `meta.agentId`、`score`、`why`；
- memory / skill 出现在 `skipped` 且带原因；
- 无线索时 `searched` 写的是"没有查"，不是"查了没有"；
- qa 与 history 共用一份 `searched`，各自保留出处；
- `limit` 由调用方决定。
- **变异验证**：把 memory/skill 静默丢弃 → 测试红；把"没有查"写成"查了" → 测试红。

## 不做

- **不把记忆/技能搬到后端**：跨进程读子进程的向量库要新增一条数据通路，当前没有需求；`skipped` 已经把缺口说清楚。
- **不让 capability 走模型重排**：仍然是确定性打分（ADR 0056）。

## 后果

- 新增一个召回源 = 在 `recall` 里加一段 + 一个枚举值，调用方不改。
- 三处调用点共享一份 `searched`/`skipped` 语义，渲染文案只有一处。
- 「为什么它没想到这件事」现在能回答成三种之一：没查（没有线索）、查不到（跳过了）、查了没有。
