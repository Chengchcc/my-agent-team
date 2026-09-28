# 停靠 HITL 的 Run 在 backend 重启后可恢复（中途落盘 + 决定注入）

> 状态：**Implemented**（2026-09-28；实现时把决策 2 修订为「停靠标记」设计，见该条）。

## 背景

one-shot child 架构下，子进程与 backend 同生共死。`recover()` 的孤儿扫描会把「输入已投递、无活子进程」的活跃 run 终结为 `aborted`，并取消它的全部 pending action（`execution-service.ts` 的注释原话：「run_lost: the approval can never be answered - cancel it」）。

这不是理论场景：审批与追问的等待窗口默认 **24 小时**（聊天面上的人可能第二天早上才回），期间一次发版重启、一次机器重启，停靠中的问题就死了——用户点了「允许」也没有人接。

更深的约束在子进程的持久化时机：oma 的 session 文件**只在整轮完成后追加**（`rpc-mode.ts`：`outcome.status === "completed"` 才 `appendSessionMessages`）。崩溃轮里已经发生的一切——assistant 的 tool_use、**已经执行完的工具**、停靠中的审批——全都不落盘。

由此推出两条硬事实，排除两个天真的修法：

1. **「重启后重跑同一输入」不可接受**：崩溃前已执行完的工具会再执行一遍（文件写入、bash 副作用），且模型重跑产生的审批请求与用户当初批准的内容可能不同——把旧决定盲目套在新请求上等于假授权。
2. **「保留 pending 行、答案降级成新输入」也不诚实**：新 run 同样从上一次完成轮的种子重跑中断轮，副作用重放问题原样存在，只是把「resume」包装成了更模糊的东西。

结论：**恢复的单位必须是「停靠的 tool_use + 已到达的人的决定」，而不是整轮重跑。** 这要求轮内中间产物先落盘。

分层前提（恢复机制跟着**状态所有权**走）：HITL 有两层。**编排层**的 `ask_question` 是产品功能，经 product-tools MCP 注入四端、停靠与落库都在 backend——它的恢复原则上不需要 child 配合。**运行时原生层**的 oma 审批是 oma 自己的 permission 门经 RPC 透出，parked promise 活在 child 循环里——它的恢复必须 child 侧机制（下述 2+3）。三个 CLI 后端的原生提示在 headless 下没有可应答的 wire，对编排器不可见，不在讨论范围。

## 决策

1. **决定注入，不是重演。** durable pending action 的 response——approval 的 decision、ask 的 answer，一律作为该停靠 tool_use 的**合成 tool_result** 注入恢复后的循环：child 载入 session 种子后，不重调模型重演前文，循环从断点继续。callId 即 tool_use id，无需对载荷做匹配器。
2. **oma 轮内落盘：实时对话消息 + 停靠标记（实现修订）。** 原案是「每完成一个 tool result 立即 append」，实现时发现它撞上循环的既有不变量：assistant(tool_use) 与全部 tool_result **一批原子写入**，store 里永远没有悬空 tool_use（悬空对模型 API 是 400）。修订为两层：①对话消息（prompt/assistant 文本轮/tool_result）经 `onPersistMessages` **实时**落 session 文件（TUI 已有的钩子，rpc-mode 此前没接）；②`executeTools` 之前把该轮的 assistant(tool_use) 以独立事件类型 **parked_turn 标记**写入文件——正常加载只读 message 事件、标记不可见（崩溃轮从普通视角「从未发生」），只有 resume 路径读它。悬空状态只存在于崩溃与恢复之间，由恢复阶段修复配对。
3. **wire 协议加 resume 输入。** `agent-contract` 的 `BackendRunInput` 增加可选 `resume` 字段：该 run 已决定的 action 清单（callId + kind + response）。child 侧语义：种子 = session 消息 + 未失效标记的 assistant(tool_use)；恢复阶段对每个停靠调用分流——ask 的答案直接成为合成 tool_result（重新发起 ask 会挂起一个**新** pending action，绝不重发）；approval allow 则**真执行**该工具（决定经 callId 预供，人不被重问——批准的是动作，不是结果文本）；deny 与无决定的调用注入诚实的 denied/interrupted 错误结果。恢复的结果先于新一轮 meta 落盘，首个模型调用永远看不到未配对的 tool_use。
4. **backend `recover()` 停止清场停靠 run。** `waiting` 且仍有 pending action 的 run 不进孤儿扫描（保持 waiting，分支继续被占）。它的终局只有三种：人答了（→ 见 5）；审批超时/取消（→ 合成 deny/timeout 结果，同样走 5 收尾）；显式 stop。
5. **回答触发 resume-dispatch。** 无活 loop 时消费 pending action，记录决定后，用**原 runId、原输入**附 `resume.decisions` 重新 dispatch（`recover()` 重投 `delivering` 输入已依赖「新进程无记忆、同 runId 同 payload 可重入」的既有语义）。run 状态经既有的消费 CAS 回 `running`，watchdog 重新武装。
6. **ask 与 approval 在 oma 内走同一机制——经济选择，不是分层必需。** `ask_question` 的 MCP tool_use 也是轮内工具调用，其合成 result 就是答案 JSON。它的状态所有权本在 backend（分层上它可以走 7 的重派机制），但 per-step 落盘与注入这台机器已为审批造好，ask 搭车零边际成本，还省掉重跑的 token 与副作用重放。
7. **两条通道的范围不同，恢复机制也不同。** approval（`approval_requested` + `resolveApproval` RPC）是 oma 独有：另外三个 CLI 后端没有审批管道，headless 下也不产生可回答的审批卡。**ask 通道则四端同构**：`ask_question` 经工作区 `.mcp.json` 注入（omp/pi 读 cwd，claude 走 `--mcp-config`，oma 走 mcp-mount），停靠完全发生在 backend 进程（product-tools 服务）——所以三个 CLI 后端的 run 同样会「ask 停靠中 backend 重启 → 孤儿 abort」，只是它们的恢复不能走 session 注入（外部 CLI 没有「替它补一个 tool_result」的线）：re-dispatch 带各自 session 引用重跑中断轮，若模型再次问到**内容一致**的问题，backend 用已存答案自动应答（ask 的答案对应问题文本，内容匹配语义成立——这与 approval 不同，批准绑定的是具体动作，错配即假授权）；不一致则重新问人。内容匹配自动应答是增强，第一期允许「多问一次」。
8. **明确不做：**
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
