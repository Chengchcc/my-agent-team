# ADR 0061: 注意力债 —— 未读、草稿与打扰纪律

- 状态: Proposed
- 日期: 2026-11-17
- 相关: ADR 0046（环境规则 record/act）、ADR 0049（前台不变量）、ADR 0059（双路回填）、ADR 0060（验收与署名）

## 背景

对 [herdr-super-agent](https://github.com/ergunozyurt/herdr-super-agent) 的代码审计（`lib/store.mjs`、`lib/delivery.mjs`、`lib/core.mjs`、`skill/SKILL.md`、`RECIPE.md`）给出一个我们今天没有的轴：它不管理执行，它管理**人欠 agent / agent 欠人的一步**。

它的实体叫 **request**：`unread → waiting-human → waiting-agent → resolved`，`unread` 与状态正交；回复带 `expected-revision` 栅栏，草稿记 `draft_revision`；投递是 `pending → submitted / failed / unknown` 三值加对账。

**为什么不能照搬实体**：它建 request 表是因为它的"后端"就是那个 SQLite 文件，实体即事实。我们的后端已经有事实：`pending_action`（`actionId / runId / kind / payload / status / response / createdAt / resolvedAt`）、`GET /api/pending-actions`（全局读模型，`/today` 与 TopBar 铃铛都读它）、两条渲染面（飞书卡片 + Web `AskQuestionCard`）。再建一张 request 表就是第二份事实。

实测差距只有三样：**未读、草稿、打扰纪律**。

## 决策

### D1 债务是派生视图，不建表

```
等你答   = pending_action.status = 'pending'
等 agent = pending_action 已 resolved 且该 run 仍活跃
未读     = 对方最后一次动作（提问/追加/终态回填）晚于本端 seen_at
```

三段都从现有行算出来，**没有第四张状态机**。视图只读：不允许任何代码通过"改债务"来改执行。

### D2 `unread` 的语义是"对方有新内容"，不是"你还没看这个待办"

- 打开该问题即写 `pending_action.seen_at`；
- 人答完 → 该条进入"等 agent"（对方欠人）：`resolvedAt` 已记，无需新列；
- agent 的终态回填到达 → 若人没看过回填，条目标未读。

这条语义借自 herdr：`unread` 与状态正交，且**只由对方的动作推进**。做成"你还没点过这个待办"会让未读永远为真，等于没有。

### D3 草稿：一行小表，绑 `(runId, callId)`，回答即清

```
answer_draft(run_id, call_id, body, updated_at)  PRIMARY KEY(run_id, call_id)
```

- 人的自由文本追问刷新/切页不丢；
- 回答成功即删除（"已提交的草稿"没有意义）；
- **不做** `expected-revision` 栅栏：我们的 ask 是一次性的（没有 append），问题不会在等待期间被上游改写；若将来出现 append，先复用 `pending_action.responseIdempotencyKey` 的既有语义，再加版本。

### D4 打扰纪律进前台常量（本 ADR 唯一会动模型行为的部分）

`FRONT_DESK_DISCIPLINE` 现在只写"怎么路由"，不写"**何时可以占用人的注意力**"。补五条：

1. **先登记再问**：向人提问前必须先走 ask 工具（它同时是登记）。不许在正文里顺带问一句。
2. **一次一个决定**：一件待决事只占一个 ask；补充信息进同一问题的正文/选项，不开第二张卡。
3. **失败显式报错，不降级**：工具失败就在回复里说清失败与影响；**不许**因为工具坏了就改用普通文本问人（那是把协议悄悄降级）。
4. **答复即行动**：收到回答直接执行；不写"收到/好的/谢谢"这类空转。
5. **无需输入即收尾**：不再需要人答就直接结束，不把问题留在那里。

措辞取自 herdr 的 `SKILL.md`（它把这条写成了硬纪律："fail visibly, not by falling back"）。我们已经在 `report` 上拒绝未知 `verification`、在派单上拒绝缺料——这条是同一原则的前台版本。

### D5 不做

| 不做 | 理由 |
|---|---|
| `Human Request` 表 | 与我们已否掉的 Task 聚合同型；`pending_action` 已覆盖五列，缺的只是未读与草稿 |
| `append` / `expected-revision` | 我们的 ask 一次性；没有追加就没有版本冲突 |
| 投递三值 `unknown` + 对账 | 我们的投递不经过 argv 粘贴，已选"至少一次 + 偶发重复"（ADR 0060 D6） |
| 会话级开关 | 它防的是"向终端粘贴"这个失败模式；我们没有这个面 |

## 不变量

1. **债务视图只读**：任何执行事实只能从 run / 账本写入，不能从视图写回。
2. **未读只由对方动作推进**，不因本端打开而"变新"。
3. **草稿绑 `(runId, callId)`**，回答成功即删；草稿不是事实，不进账本。
4. **打扰必须是一次登记过的问题**（ask 行），不允许以纯文本形式占用注意力。

## 落点

| 层 | 文件 |
|---|---|
| 数据 | `infra/db/schema.ts`：`pending_action.seen_at`（可空）、`answer_draft` 表 + 迁移 |
| 读模型 | `features/agent-run/http.ts` 的 `/api/pending-actions` 增三段与 `seen`；`apps/web` 的 `/today` 三段化 |
| 草稿 | `apps/web` 的 `AskQuestionCard` 落草稿与清理；后端两个小接口（读/写草稿） |
| 纪律 | `features/agent/prompt-front-desk.ts` 增五条 + 回放语料重跑 |

## 验收

1. 三段视图：等待中、已答未终态、终态未读，各有测试；已读后不再出现"未读"。
2. 未读只由对方动作推进：人打开问题 → 不产生未读；agent 回填 → 产生。
3. 草稿：写入后刷新仍在；回答成功后消失；不同 callId 互不覆盖。
4. 纪律：`FRONT_DESK_DISCIPLINE` 的五条由回放脚本断言出现，且重跑基线（flash / v4-pro 多次取分布，单次不算）。
