# ADR 0065: 给长期记忆一个生产者 —— 只由人授权的 `remember`

- 状态: Accepted（工具与授权已实现；**真机闭环已验证**：remember → `product.md` → 后端召回 → 系统提示；中文按二字 shingle 匹配）
- 日期: 2026-11-18
- 相关: ADR 0064（读路径）、ADR 0058（统一召回）、ADR 0060（授权依据）

## 背景

ADR 0064 让后端能读 agent 工作区的记忆库，真机却发现产品 run 里**没有任何写入者**：`learn` / `retain` / `backfillLearnedLessons` 全部挂在 `localMemory`（独立模式专用）之下。于是读路径永远读空。

现在的选择不是"要不要记忆"，而是**"产品里谁有权写下一条记忆"**。三个候选在 ADR 0064 D7 里列过，本文给出推荐与边界。

## 决策

### D1 生产者 = 产品工具 `remember`，且只能由人授权

```ts
remember({ text, scope? })   // scope 暂不开放，恒为"本 agent 的长期记忆"
```

- **授权**：只有 `authorization === "user"` 的 run 可以写（人直接对它说话的那一轮）。`dispatch:` / `ambient:` / `result:` / `system` 一律拒绝——规则、工人、系统都不许往人的长期记忆里塞东西。
- **落点**：写 agent 工作区的 `.oma/memory/product.md`（同样的 `- [YYYY-MM-DD] 事实` 行格式；**不是** `learned.md`，原因见 D5）。
- **不写库**：产品进程不直接写向量库。理由：库是独立模式与子进程的产物，产品侧插一行会绕开它的去重/引用计数/embedding 生成语义。

### D2 读回来的内容要标出处，且永不自动填槽

- 召回块里 `memory` 命中标注 `memory (agent-written, <date>)`：它是**回忆**，不是指令；
- 已经成立的规则继续成立：召回只给**线索**，槽位值必须由模型在派单里显式写出（ADR 0055 的"不猜"）。

### D3 `backfillLearnedLessons` 仍只在独立模式跑

**不要**为了"让产品能读"就把 backfill 搬进产品 run：`learned.md` 是 agent 可写文件，自动摄入等于让工作区内容无声地影响派单判断——这正是 `localMemory` 被限制成独立模式的原因。

产品的写入必须走 D1 的**人来发起**这条缝；文件被谁手改过，不该因此变成产品事实。

### D4 拒绝另外两个候选

| 候选 | 拒绝理由 |
|---|---|
| 产品 run 跑 backfill | 自动摄入 agent 可写文件 ⇒ 注入面（见 D3） |
| 回退读路径 | 读路径已实现且有测试；删掉它等于承认"记忆只能手工翻文件"，成本更高 |

### D5 真机修正：产品记忆用**自己的文件**（2026-11-18）

D1 原本写"写 `learned.md`，由 backfill 同步进向量库"。真机否掉了这个闭环：

- `remember` 成功写了 `learned.md`；
- 但产品 run **从不跑 backfill**（D3 的刻意选择），`memory.db` 不存在；
- 于是下一轮召回**读不到任何东西**——输入里连召回块都没有。

写方写文件、读方读库，中间那道同步被 D3 关掉了。

修正：产品记忆写 `<workspace>/.oma/memory/product.md`，**由后端直接按行读**（关键词匹配，不经向量库）。真机二次验证（2026-11-18）：

```
turn 1  recall hits=0 block=0   searched=history:0      ← 无 cue 不查；remember 调用成功
turn 2  recall hits=2 block=543 searched=memory:1,qa:0,history:1
```

那一轮的输入里**没有**召回块（它进的是系统提示），所以可见性靠一行 `debugLog`（`recall ... hits= memory:` 计数）——否则"召回到了没有"没有任何可观察面。

第二处修正：中文查询不能用整句匹配。共享的 `needleSegments` 把连续汉字当成一个 needle，`"还记得上次登录重定向那个根因吗"` 整句在事实行里当然找不到；改为**二字 shingle + 命中计数**（两次命中共现才算），英文词照旧。这条是"真机发现、单测补钉"。

这样：

- 闭环成立，且与独立模式的 `learned.md` / 向量库**互不干扰**；
- 写入权仍只由 `user` 授权的 run 持有；
- 手改 `learned.md` 依旧不会成为产品事实（D3 的边界保住了）。

## 不变量

1. **只有 `user` 授权的 run 能写记忆**（与不可逆动作同一条门槛）。
2. 记忆命中是**线索**，不是指令；不得自动填充槽位。
3. 产品进程**不直接写向量库**；文件是唯一写入口。
4. **"只由人授权"这条规则写在工具描述里**（模型每轮都读），而不是 `FRONT_DESK_DISCIPLINE`：后者是路由语料的一部分，为一条工具规则重跑整个基线不划算。
4. 工作区文件被手改**不会**自动变成产品事实（除非人再次授权写入）。

## 落点

| 层 | 文件 |
|---|---|
| 工具 | `features/product-tools/{manifest,dispatch,service}.ts`（`remember`） |
| 授权 | service 侧检查 `run.authorization === "user"` |
| 写入 | 追加到 `<workspace>/.oma/memory/learned.md`（格式与 `learn` 一致，文件不存在则建） |
| 提示 | 前台纪律加一条：只有人明确说"记住"才写；不主动积累 |

## 验收

1. `user` 授权的 run 调 `remember` → `learned.md` 多一行，格式与 `learn` 相同（有测试）。
2. `dispatch:` / `ambient:` / `result:` 授权的 run 调 `remember` → 拒绝，文件不变。
3. 同一事实重复写：按 `learned.md` 的既有格式去重（与 `learn` 行为一致）。
4. 记忆命中在召回块里带 `memory (agent-written, <date>)` 标注（一条渲染测试）。
5. 变异：把授权检查改成恒真 → 红；把写入改成向量库直写 → 红（或直接删掉该实现）。

## 后果

- 人的"记住这个"真正记得住，且只有人能发起；
- 记忆仍然**不能**从工作区文件自动变成产品事实——这条边界保留；
- 独立模式（TUI/print/json）的 `learn` 语义不变。
