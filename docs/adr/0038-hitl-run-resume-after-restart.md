# 停靠 HITL 的 Run 在 backend 重启后可恢复（中途落盘 + 决定注入）

> 状态：**Accepted**（设计已定，实现分期见「后果」末节）。

## 背景

one-shot child 架构下，子进程与 backend 同生共死。`recover()` 的孤儿扫描会把「输入已投递、无活子进程」的活跃 run 终结为 `aborted`，并取消它的全部 pending action（`execution-service.ts` 的注释原话：「run_lost: the approval can never be answered - cancel it」）。

这不是理论场景：审批与追问的等待窗口默认 **24 小时**（聊天面上的人可能第二天早上才回），期间一次发版重启、一次机器重启，停靠中的问题就死了——用户点了「允许」也没有人接。

更深的约束在子进程的持久化时机：oma 的 session 文件**只在整轮完成后追加**（`rpc-mode.ts`：`outcome.status === "completed"` 才 `appendSessionMessages`）。崩溃轮里已经发生的一切——assistant 的 tool_use、**已经执行完的工具**、停靠中的审批——全都不落盘。

由此推出两条硬事实，排除两个天真的修法：

1. **「重启后重跑同一输入」不可接受**：崩溃前已执行完的工具会再执行一遍（文件写入、bash 副作用），且模型重跑产生的审批请求与用户当初批准的内容可能不同——把旧决定盲目套在新请求上等于假授权。
2. **「保留 pending 行、答案降级成新输入」也不诚实**：新 run 同样从上一次完成轮的种子重跑中断轮，副作用重放问题原样存在，只是把「resume」包装成了更模糊的东西。

结论：**恢复的单位必须是「停靠的 tool_use + 已到达的人的决定」，而不是整轮重跑。** 这要求轮内中间产物先落盘。

## 决策

1. **决定注入，不是重演。** durable pending action 的 response——approval 的 decision、ask 的 answer，一律作为该停靠 tool_use 的**合成 tool_result** 注入恢复后的循环：child 载入 session 种子后，不重调模型重演前文，循环从断点继续。callId 即 tool_use id，无需对载荷做匹配器。
2. **oma 循环中途落盘（per-step durability）。** 轮内每完成一个 tool result、每产生一条 assistant 消息，立即 append 进 session 文件。这是恢复的前提——崩溃时文件里已有 partial turn；也是工具 exactly-once 的来源——恢复的循环看到已完成工具的结果，跳过它们。append 是 O(1)（`lastIdBySession` 缓存已在）。
3. **wire 协议加 resume 输入。** `agent-contract` 的 `BackendRunInput` 增加可选 `resume` 字段：该 run 已决定的 action 清单（callId + 合成 result）。child 侧语义：载入种子后注入这些 tool_result；session 里有 tool_use 但既无结果也无决定的（人没答、进程先死），按「工具被中断」注入 isError 结果——诚实，且循环可继续。
4. **backend `recover()` 停止清场停靠 run。** `waiting` 且仍有 pending action 的 run 不进孤儿扫描（保持 waiting，分支继续被占）。它的终局只有三种：人答了（→ 见 5）；审批超时/取消（→ 合成 deny/timeout 结果，同样走 5 收尾）；显式 stop。
5. **回答触发 resume-dispatch。** 无活 loop 时消费 pending action，记录决定后，用**原 runId、原输入**附 `resume.decisions` 重新 dispatch（`recover()` 重投 `delivering` 输入已依赖「新进程无记忆、同 runId 同 payload 可重入」的既有语义）。run 状态经既有的消费 CAS 回 `running`，watchdog 重新武装。
6. **ask 与 approval 走同一机制。** `ask_question` 的 MCP tool_use 也是轮内工具调用，其合成 result 就是答案 JSON。不为 ask 单开路径。
7. **明确不做：**
   - 不做整轮 checkpoint / 回滚（roadmap「Run 的中途暂停」保持独立条目）；
   - 不为无停靠点的崩溃 run 做 resume（重跑 = 副作用重放，孤儿 abort 语义保持）；
   - 不加回 span/attempt 之类的第二执行身份（Phase 6 的教训：恢复机制不得拥有独立生命周期）。

## 后果

- **收益**：验收标准「action 卡发出后任意时刻杀掉 backend，重启后仍能看到同一条待处理 action；答一次，run 恢复且只恢复一次」对 approval/ask 达成（工具 at-least-once 边界除外，见风险）。runId 不变，Lark 卡片与 Web 的 run 绑定天然续上。
- **代价**：oma 循环与 wire 协议各加一块；session 文件写入从每轮一次变为每步一次（量级：一次 appendFileSync，可接受）；usage 对崩溃段少计（child 死于无 outcome，段内 token 无从回收——诚实记录，不做假账）。
- **风险**：
  - per-step append 与 compaction 的交错：`appendSessionCompaction` 现在假设轮结束后调用，中途 append 必须维持 parentId 链一致（实现时用变异探针钉住）；
  - session 坏行恰是停靠 tool_use 时，恢复退化为「工具被中断」（已有逐行降级路径，不 brick）；
  - 崩溃瞬间**正在执行**的工具是 at-least-once（结果没来得及落盘就死了，恢复后重执行）——与 `commit_failed` 的既有语义一致，接受并写进操作文档。
- **分期**：child 侧（2+3）与 backend 侧（4+5）必须一起上线——只有 4 会留僵尸 waiting run。实现顺序：先做 2（独立有价值：任何崩溃的损失都变小），3+4+5 一个批次。
