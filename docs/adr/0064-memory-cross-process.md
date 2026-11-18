# ADR 0064: 长期记忆对后端可见 —— 读文件，不加通道

- 状态: Proposed
- 日期: 2026-11-18
- 相关: ADR 0055（记忆检索进意图）、ADR 0058（统一召回入口）

## 背景

ADR 0058 把「记忆 / 技能 / 工人」收敛成一个召回入口，但当时 `memory` 与 `skill` 只能报 `skipped`，理由是它们**活在 run 的子进程里**。

这个理由对技能成立（技能包是子进程装配的一部分），对记忆不成立：记忆是 **agent 工作区里的一个 SQLite 文件**（`<workspace>/.oma/memory/memory.db`，`packages/embedding` 的 `openVectorMemoryStore`），后端本来就与它在同一台机器、同一块磁盘上。

于是「长期向量记忆的跨进程可见性」并不是通道问题，而是**范围问题**：谁能读、读谁的、读不到时算什么。

## 决策

### D1 读文件，不加协议

后端用 `openVectorMemoryStore` 只读地打开该文件，跑 `recallMemories`（向量 + 关键词两路，RRF 融合）。不新增子进程上报、不复制数据、不加缓存。

**不建库**：文件不存在就直接返回空——store 的构造会 `CREATE TABLE`，一个只读消费者不该写盘。这条有测试（`existsSync` 断言）。

### D2 范围 = 会话的前台 agent

召回用在「写 brief 之前」：`recallForRun` 在派发 run 时计算，喂给意图识别与缺料判断。所以读的是**人正在对话的那个 agent**（会话的 front desk）自己的记忆。

**不读工人的记忆**：工人拿到任务之后要不要回忆，是工人自己回合里的事（它有 `memory` 工具）。把工人的记忆合并进前台的召回，会让"我记得"的主语变得含糊。

### D3 语音可降级：向量或关键词，二者皆可

- 配了 `BACKEND_EMBEDDING_MODEL` + `BACKEND_EMBEDDING_BASE_URL`：向量 + 关键词；
- 没配：只有关键词（bm25/LIKE）。**更窄，但不坏**——这是存储层自己的契约（provider 失败时 FTS 仍然作答）。

命中要说明"为什么浮上来"：`why` 里写 `vec 0.83 · fts` 还是只有 `fts`，读者能分辨语义命中与字面命中。

### D4 引用形状 `mem:<id>`

与 `seq:412` / `agent:fe` 同族：可被模型引用、可被人回查。响应里还带上 `source`（`learn` / `autonomous` / `retain`）与创建时间。

### D5 失败 = 空，不阻塞派发

工作区解析失败、库文件损坏、被锁：一律返回空列表，由 `recall` 记为"查过但没结果"。召回是辅助，不能挡住一轮工作（这条与现有 recall 的失败语义一致）。

### D6 不做

| 不做 | 理由 |
|---|---|
| 后台/子进程推送记忆到后端 | 文件就是事实，推送会引入第二份副本与一致性问题 |
| 跨 agent 聚合记忆 | 主语会变含糊（见 D2） |
| 从后端**写**记忆 | 记忆的写入仍属于子进程（learn/autonomous），后端只读 |

## 不变量

1. **只读**：不存在就不打开；不建表、不改行。
2. **没有 cue 不查**（沿用 ADR 0055：模型不知道自己缺东西，由代码判断）。
3. **失败即空**，永不阻塞派发。
4. **命中必带出处**（`mem:<id>` + `why`）。

## 落点

| 层 | 文件 |
|---|---|
| 适配器 | `apps/backend/src/features/recall/memory-recall.ts`（`createMemoryRecall`，只读、可降级） |
| 召回 | `features/recall/recall.ts`（`searchMemory` 端口；有端口就查，没端口报 skipped） |
| 派发 | `features/agent-run/{recall,execution-dispatch,execution-types}.ts`（`memory` 加入 fan-out） |
| 组装 | `bootstrap/features.ts`（`workspaceOf` 解析会话前台的工作区；embedding 客户端可选） |

## 验收

1. ✓ 从没学过的 agent：返回空，且**不创建**库文件（变异：去掉存在性检查 → 红）。
2. ✓ 学过的记忆按关键词命中，带 `source` 与 `why`（变异：把查询置空 → 红）。
3. ✓ 失败场景（工作区解析抛错）返回空而不是异常。
4. ✓ 统一召回里 `memory` 有端口就进 `searched`、命中带 `mem:<id>`；没端口才进 `skipped`（两条测试）。
5. **未做**：真机验证（需要在真栈里让 agent `learn` 一条再问它，成本较高，留待下次实机运行）。
