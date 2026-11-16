# ADR 0054: 派单的意图用「维度」表达，不用一个 kind 枚举

- 状态: Implemented
- 日期: 2026-11-16
- 相关: ADR 0047（房间派单）、ADR 0049（前台不变量）、ADR 0051（授权链）、`docs/notes/intent-and-attention-research.md`

## 背景

派单目前只要求一句 `instruction`。含糊的话「修一下登录」在派出去那一刻就硬化成一次执行——这是早收敛（early posterior collapse）的典型场景：后续澄清会被当成补充信息，而不是纠正信号。

第一版设计是"派单前必须填固定的四格：目标 / 验收 / 范围 / 约束"。**这个设计是错的**：

- `review`（评审一个 diff）没有"范围"，也不该有——硬要填，模型就会编一个；
- `operate`（重启 staging）的"范围"和"验收"都不如"回滚方式"重要；
- 四格对所有 kind 一视同仁，等于逼模型为不存在的维度编造内容，**比不填更糟**：账本上留下的是假信息。

## 决策

### D1 四个正交维度，不是一个枚举

| 维度 | 取值 | 谁定 |
|---|---|---|
| `verb` | fix / build / review / investigate / write / operate / answer | 模型选（封闭表） |
| `deliverable` | answer / change / report / state-change | 模型选 |
| `object` + `objectKind` | 自由文本 + code/doc/service/data/other | 模型填 |
| `reversibility` | reversible / irreversible | **代码推导**，模型可不填（缺省 irreversible） |

槽位由 `(verb, deliverable)` **推导**，写在 `SLOTS_BY_VERB`：

```
fix        repro · expected · scope · acceptance
build      goal · scope · acceptance · constraints
review     target · criteria
investigate question · sources · stop
write      audience · form · source
operate    environment · action · rollback
answer     （无 —— 它本来就不出这张桌子）
```

### D2 枚举为什么不行（四条，都有出处）

1. **每加一类就重划全部边界。** 这是 Rasa 对意图分类体系的核心批评：边界一动，无关路径跟着回归。维度里加一个动词不影响别的动词，加一个对象类型不影响任何动词的槽位。
2. **风险必须独立于任务类型。**「重启 staging」可逆，「重启生产」不可逆。枚举里这会被迫拆成两个 kind（然后所有 kind 乘二）；维度里只是 `reversibility` 变了。
3. **多意图天然可拆。**「修登录 + 更新文档」= 两个 brief；枚举里只能造"复合 kind"，然后要两套槽位的并集。
4. **兜底不丢信息。** 认不出动词时 `answer` 兜底，`deliverable` 与 `acceptance` 仍在；枚举兜底只剩一个名字。

### D3 证据与决定分开

模型只产出维度（证据）；**由维度推出槽位、由槽位推出问什么、由 `reversibility` 推出要不要人授权——这些在代码里**。

因此本 ADR 的核心不是那张表，而是这条边界：

> 加一个动词、改一张表，都不可能悄悄改掉"什么情况下必须先问人"。

### D4 不可逆操作只能由这一轮的人类授权

`verb=operate` 且 `reversibility=irreversible` 时，派单的 run 的 `authorization` 必须是 `user`（人在这一轮亲口说的）。规则或研判发现的不可逆操作只能去问人，不能替人决定。

这条用既有授权链实现，不新增字段：**边界，不是判断**。

### D5 缺口一次说完

缺槽位的拒绝信息列出**全部**缺口，并明确禁止编造：

```
fix needs repro, expected, acceptance. Do not invent them — call
ask_question for all of them at once, then dispatch.
```

一次只问一个字段是已记录的失败模式（对话管理里叫"挤牙膏"），对模型同样成立。

### D6 工人看到的是规格，不是转述

派单消息按固定格式：动作/交付/对象 → 槽位 → 可逆性 → 引用 → **请求者原文（逐字，放最后）**。原文是证据，槽位是规格；两者都在，工人才能在执行时校验。

## 落地

| 文件 | 改动 |
|---|---|
| `apps/backend/src/features/product-tools/intent.ts`（新） | 维度类型、`SLOTS_BY_VERB`、`parseBrief`、`missingSlots`、`describeMissing`、`needsHumanAuthority`、`frameBrief` |
| `apps/backend/src/features/product-tools/service.ts` | `dispatchWork` 先解析维度 → 查缺口 → 查人授权 → 再走原有成员/池子逻辑 |
| `apps/backend/src/features/product-tools/{manifest,dispatch}.ts` | 两份 schema 都加 `verb` / `deliverable` / `object` / `objectKind` / `references` / `reversibility` / `slots`；`required` 变为 `["instruction","verb","deliverable"]` |
| `apps/backend/src/bootstrap/features.ts` | 派单消息改用 `frameBrief`（`frameDispatchInput` 退役） |
| 测试 | `intent.test.ts`（9 条）+ `service.test.ts` 4 条执行面 |

## 验证

- 缺 verb → 拒绝，并提示"这只是个问题就回答，不要派单"；
- `review + change` → 拒绝，提示拆成两个 brief；
- `fix` 缺三格 → 一次列出三格，且**没有调用 dispatch dep**；
- 不可逆 `operate` 在 `ambient:` 授权下 → 拒绝；同一份 brief 在 `user` 授权下 → 放行；
- 门禁：两份 schema 由 `manifest-drift.test.ts` 保证不漂。

**变异验证（各自变红）**：去掉人授权检查 → 对应测试红；去掉缺口拦截 → 对应测试红。

## 不做

- **不做 `general` 兜底动词**：`answer` 是"不派单"，不是兜底；认不出动词时正确答案是问，不是塞进一个万能类。
- **不把表做成可配置**：它是产品判断（不可逆要人授权、评审不需要范围），不是部署参数。可编辑就会产生"某个部署的表不同"的沉默分歧。
- **不在这里做记忆检索**：`recall` 是意图识别的输入（ADR 0055 待写），本 ADR 只定"派什么、缺什么"。

## 后果

- `instruction` 从"唯一输入"降级为"证据之一"；真正的契约是四个维度 + 槽位。
- 派单失败的概率上升（缺料会被拒），但失败发生在**写账之前**，而不是干完一半之后。
- 账本上每条派单都能回答"它当时以为这是什么活、缺什么、谁授权的"。
