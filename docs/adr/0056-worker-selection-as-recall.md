# ADR 0056: 选人是能力召回（取代 ADR 0052 的池子规则）

- 状态: Implemented
- 日期: 2026-11-16
- 相关: ADR 0052（池化调度，本 ADR 取代其选择规则）、ADR 0054（意图维度）、ADR 0055（记忆召回）

## 背景

ADR 0052 的池子只吃一个自由文本 `capability`，按它做子串过筛，再按"空闲 → 最近启动 → id"排序。

ADR 0054 之后，前台已经知道了任务的四个维度（`verb`/`deliverable`/`object`/`reversibility`）和槽位，但**这些信息没有进入选择器**。后果很具体：

- `verb=review` 的任务可以落到一个卡片只写着"修 bug"的工人身上（只要 `capability` 为空或不冲突）；
- 前台忘了传 `capability`，选择就退化成"谁最闲谁去"，能力完全不参与；
- 拒绝信息只能说"没有匹配的工人"，说不出为什么。

**维度和路由是断的。**

## 决策

### D1 选人就是一次召回

与记忆召回（ADR 0055）、技能召回同构：

```
索引：能力卡（name + description + skills）
查询：由 brief 构造（verb / deliverable / objectKind / capability / 槽位里的实词）
结果：带分数与理由的命中 + 检索清单
```

用同一套词汇表达"我认识哪些"，意味着修召回质量时只需要修一处。

### D2 查询来自 brief，不是一句提示

| 信号 | 来源 | 权重 | 例 |
|---|---|---|---|
| verb | `brief.verb` | 4 | 卡片写"评审/审查"命中 `review` |
| 对象类型 | `brief.objectKind` | 2 | 卡片写"文档/README"命中 `doc` |
| capability | 前台显式给的提示 | 3 | "react" |
| 槽位实词 | `brief.slots` 切词后的片段 | 1（最多算 2 个） | scope `src/web/settings` → "web"/"settings" |

槽位值先按分隔符切段再匹配：`src/web/settings` 是**通过它的词**成为证据的，而不是作为一个整串——没有卡片会包含整条路径。

### D3 空闲是平手判据，不是加分

作为加分项，一个"空闲但不匹配"的工人会压过"忙但匹配"的工人——正是要避免的事。所以空闲只进平手排序（分数 → 活跃数 → 最近启动 → id），同时在理由里说出来。

### D4 无信号时仍然给出最好的一手

前台要的是"有人接"，不是"没有答案"。没有任何卡片匹配时，仍按负载排序选一个，但**理由里不假装匹配过**：

```
idle, chosen from 3          ← 没有任何 verb 命中时，理由里不会出现 "verb review"
```

模型看到理由可以否掉这个选择（点名派单），人也能在账本上看出"这次是硬派的"。

### D5 检索清单对外可读

`recallWorkers` 返回 `{ hits, considered, excluded }`。前台的拒绝信息因此可以说出具体原因（"团队里没有能接 review 的工人"），而不是笼统的"没有匹配"。

## 落点

| 文件 | 改动 |
|---|---|
| `apps/backend/src/features/product-tools/pool.ts` | `pickFromPool` → `recallWorkers` + `describePick`；动词/对象词表；分数与理由 |
| `apps/backend/src/features/product-tools/service.ts` | `pickAgent(query)`：由 brief 构造查询（verb/deliverable/object/objectKind/capability/槽位实词） |
| `apps/backend/src/bootstrap/features.ts` | 组装能力卡并调用 `recallWorkers` |
| 测试 | `pool.test.ts` 重写为召回语义（7 条） |

## 验证

- `review` 的 brief 不再落到"修 bug"的卡片上，即使后者更闲；
- 空闲在分数相同时胜出（去掉这条 tie-break，测试变红）；
- 槽位路径通过切词成为证据（`src/web/settings` → web 卡片胜出）；
- 前台被排除，清单写明原因；
- 无信号时不伪造理由；
- **变异验证**：去掉 verb 权重 → 两条测试红；去掉空闲 tie-break → 一条红。

## 不做

- **不做模型重排**：派单在热路径上，加一次模型调用等于把"能否派活"绑到一次调用的可用性上（ADR 0048 的同一理由）。
- **不在本 ADR 引入 `verbs` 声明字段**：词表匹配已经够用，且不需要改 agent 配置与 Web 表单。若将来同一类活被反复派错，再加"工人声明 verb"作为硬过滤，那时有数据支撑。
- **不做跨数组的负载均衡**：选择只看活跃数与最近启动，不看历史成功率。

## 后果

- 派单理由变成一句可读的证据（`verb review (评审/审查), object code (react), chosen from 3`），写进账本。
- 池子为空的拒绝信息可以指认原因。
- 召回语义在记忆、技能、能力三处统一；下一步可以把它们合并到一个 `recall` 入口。
