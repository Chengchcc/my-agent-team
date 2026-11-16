# ADR 0055: 记忆检索是意图识别的输入

- 状态: Implemented
- 日期: 2026-11-16
- 相关: ADR 0054（意图维度）、ADR 0053（压缩保留）、`docs/notes/intent-and-attention-research.md`

## 背景

人说的话经常是残缺的：「那个还没修好吗」「按上次说的来」。不回看就判 `verb`，判的是噪音。

第一版设计把 recall 当成"派单之后顺手补的一层"。这是错的：**它改变分类结果**，所以必须在分类之前。

## 决策

### D1 链路位置固定

```
人话 → ① 线索抽取（确定性） → ② recall（带出处） → ③ 判 verb/deliverable → ④ 算槽位缺口 → ⑤ 仍缺才问
```

### D2 触发由代码判定，不由模型决定

问模型"你要不要回忆一下"会复现它本来要防的失败：**模型不知道自己缺东西**。而"这句话里有没有代词"是代码能判的。

线索两类：

| 类 | 例 |
|---|---|
| 回指 | 这个/那个/它/刚才/上次/之前/说过、this/that/earlier/last time |
| 标识符 | `#123`、`seq:412`、文件路径、`UPPER_CASE` 常量、版本号 |

没有线索、也没有标识符 → **一次查询都不发**（常见情况零成本）。有标识符时，query 用标识符而不是整句。

### D3 两个源，都在后端手里

| 源 | 内容 | 为什么在这里 |
|---|---|---|
| `qa` | 本会话所有 `ask` 类 pending_action：**未答的**与**已答的** | 人答过的问题被再问一次，是这个系统最容易被察觉的失败 |
| `history` | 本会话账本的关键词检索（`searchLedger`，**按会话限定**） | 全局检索会被别的房间的结果挤掉本房间的答案 |

`qa` 是**钉住**的（每次带），`history` 是**检索**的（按线索）。长期向量记忆在子进程里，后端够不到——它保持为 run 侧工具，不在本 ADR 范围。

### D4 命中必须带出处、日期、命中原因

每条形如：

```
1. [history seq:412, 2026-11-14] 用户要求登录页保持「记住我」默认勾选
   matched: 上次
```

没有日期 → 三个月的旧约定会被当成现在的；没有出处 → 模型把几条揉成一段假经历；没有命中原因 → 人和模型都不知道它凭什么叫这条。

### D5 零命中要显式，并禁止编造

块里打印检索清单：

```
Nothing matched (searched: qa=0, history=0). Say you looked and found nothing — do not invent, ask the human.
```

**"我没有"和"我没查"必须可区分**，否则模型会用前者说后者。

### D6 过期以当前为准

块尾固定一句：召回项可能过期，当前上下文与人的最新话语优先；冲突时说出来，而不是默默照旧的做。

### D7 预算是硬的

命中 ≤ 6 条（qa 最多 3 + 历史最多 6，合并后截断），单条 ≤ 300 字符。无关上下文不是"多花点钱"，是让答案变差。

## 落点

| 文件 | 改动 |
|---|---|
| `apps/backend/src/features/agent-run/recall.ts`（新） | `extractCues` / `needsRecall` / `collectRecall` / `renderRecallBlock` |
| `apps/backend/src/features/agent-run/execution-dispatch.ts` | 派发前按人话计算 recall，失败不阻断 Run |
| `apps/backend/src/features/agent-run/execution-input.ts` | recall 块拼进 run 的 Product Context（随 systemPrompt 冻结） |
| `apps/backend/src/features/agent-run/execution-types.ts` | `conversationSearch` 依赖（结构化，便于测试） |
| `apps/backend/src/features/agent-run/ports.ts` + `adapter-sqlite-actions.ts` | `listActionsForConversation` |
| `apps/backend/src/features/conversation/{ports,adapter-sqlite}.ts` | `searchLedger` 增加会话作用域 |

**为什么拼进 systemPrompt 而不是用户消息**：它随 Run 冻结、跟随每一次续跑，且不会被当成"人说的话"复述回去。

## 验证

- 线索：独立句不触发；代词/回指触发；标识符单独触发且 query 优先用标识符；
- 零命中块包含检索清单与"不要编造，去问人"；
- 命中行包含 source/ref/日期/命中原因；
- `qa` 两条（未答 + 已答）都被钉住；历史按会话限定且保留 `seq`；
- 预算：20 条命中输入 → 输出 ≤ 6；
- **变异验证**（各自变红）：去掉线索短路 → "不接触任何端口"测试红；去掉会话限定 → 作用域测试红。

## 补充（2026-11-16）：缺口先查证据，再问人

第一版只把 recall 拼进提示词——模型"被告知"，但没有代码保证它不问已经答过的问题。补上一条：

`dispatch` 的槽位校验失败时，后端把**这一轮 recall 的命中**按槽位做一次粗略匹配（`slotEvidence`：`repro` 看"复现/步骤"、`acceptance` 看"验收/测试"……），把命中连同 `ref` 一起写进拒绝信息：

```
fix needs repro, scope.
Recall from this turn may answer some of them:
- repro ← [seq:412] 点登录一直转圈，复现三次都一样
Fill what the evidence actually answers, then dispatch again.
Ask the human only for what is still missing — call ask_question once for all of them at once;
do not invent values.
```

两条边界：

- **不自动填。** 把一段记忆解读成槽位值本身就是猜测，正是本 ADR 拒绝的那类行为。代码只负责"把证据摆到模型面前"。
- **不可逆仍要人。** 即便证据齐全，`operate` + 不可逆这一条不变——证据能补信息，不能补授权。

另外，`brief.references` 现在由后端合并这一轮的 recall 命中：**模型忘了写也照样有出处**，账本上每条派单都能追到它当时看到了哪几条记忆。

顺带修一个容易漏的接法：`buildRunInput` 的参数是位置参数，新参数加在末尾；execution deps 没有 `conversationPort`，所以用结构化的 `conversationSearch` 注入，测试不需要整份端口。

## 不做

- **不在派单之后补 recall**：位置错了会改变分类结果。
- **不把长期向量记忆搬进后端**：它是 run 侧的工具，跨进程共享要新增一条数据通路，当前没有需求。
- **不做模型重排**：关键词命中已经足够区分"这个房间里说过没有"，重排要再引一次模型调用。

## 后果

- 「那个」「上次」有了可判定的解析路径，而不是让模型即兴发挥。
- 人答过的问题会出现在每次派发的上下文里（≤3 条），不必再问第二次。
- 每条 recall 都可在账本里回溯到具体 seq——人能验证它"记"得对不对。
