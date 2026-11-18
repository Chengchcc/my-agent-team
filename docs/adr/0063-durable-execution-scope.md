# ADR 0063: 持久化执行 —— 登记被打断的工作，而不是假装它还在跑

- 状态: Proposed
- 日期: 2026-11-17
- 相关: ADR 0023 §5（workspace 串行）、ADR 0038（恢复）、ADR 0059（监督与收尾门槛）、ADR 0060（至少一次回传）

## 背景

今天的不变量是**作业随 run 生死**：一次性子进程里的 bash 后台任务、subagent、eval 都在子进程里，run 终态即 teardown，`rt.close()` 回收进程组（有 P0 测试钉着）。

由此带来一个已知的体验断层：**关机/重启后，正在跑的东西不会继续，而且没人告诉你它曾经在跑。** 恢复流程把孤儿 run 判 aborted 就结束了——人只看到"那轮没了"。

"合上电脑，工作继续"因此一直是 roadmap 上的悬置项。本 ADR 把它拆成三个独立问题，并只对其中一个做决定。

## 三个问题（常被混为一谈）

1. **工作还能不能继续跑**（真正意义上的持久化执行）。
2. **人能不能知道它被打断过、打断了什么**（事实可见性）。
3. **重启后要不要自动重跑**（副作用不可判定）。

第 2 个问题是廉价的且独立于 1、3。第 1、3 个才是"常驻执行"问题。

## 决策

### D1 不做常驻守护进程

要让作业在 backend 退出后继续，必须有**一个不属于任何 run 的常驻执行体**（daemon / supervisor），承担：作业生命周期、进程组回收、重启后接管、安全面（它能在无人值守时起进程）。

拒绝理由：

- 单用户本机部署，"无人值守执行"带来的攻击面与收益不成比例；
- 与 ADR 0038 的恢复模型冲突：现在的恢复假设"没有活句柄即可判定无存活执行"，常驻执行体会让这个假设失效；
- workspace 互斥（ADR 0023 §5）是按 run 加锁的，跨进程接管需要重新设计锁的归属。

### D2 做"被打断的工作登记"：让事实可见

run 期间，本地后台作业的**生命周期**写入一张登记表：

```
run_local_job(run_id, job_id, kind, label, started_at, finished_at, outcome)
  kind: bash | eval | subagent
  outcome: finished | failed | cancelled | interrupted
```

写点：作业开始 / 结束（由子进程上报，见 D5 的协议缺口）；run 终态时仍在跑的标 `interrupted`。

恢复时：`interrupted` 的作业清单进入下一轮的系统上下文（"上一轮被打断的作业：bun test（长跑）、subagent fe 的排查"），模型据此决定重跑还是放弃。**这解决的是"人不知道为什么什么都没发生"，不是"继续跑"。**

### D3 不自动重放作业

自动重放要求判定副作用可逆：`bun test` 可以重跑，`git push`、`curl -X POST`、`gh pr merge` 不行，而系统**无法从命令文本可靠判断**（这正是我们拒绝"对命令行套 regex"的同一条理由）。

所以重放必须是**显式决定**：模型看到被打断清单后自己重跑（它读得到原始命令，也知道自己当时在做什么），或在 D4 的条件下显式声明。

### D4 若将来真要做"继续跑"，形状先写死

- 作业**显式声明** `resumable: true`（工具参数级别，不是按名字猜）；
- 只有显式可恢复的作业在 boot 时重放，且必须携带幂等键；
- 重放仍由 run 的新子进程执行（不引入常驻执行体）；
- 打断检测依赖 D2 的登记表，不能用"看起来还活着"来猜。

**触发条件**：出现"关机后必须继续"的真实场景（长构建、数据导出），且每月 ≥ 若干次；或有人愿意为常驻执行体承担运维与安全面。

### D5 协议缺口（本 ADR 的前置）

子进程今天**不上报本地作业的生命周期**：后台 bash 是"工具调用立即返回 + 进程继续跑"，父进程只看到 tool call，看不到 job started/finished；`execution-live.ts` 的"未闭合工具调用"是另一个信号（工具没返回），不能代替。

所以 D2 需要一条新事件：子进程 → 后端的 `job_started` / `job_finished`（带 jobId、kind、label）。它与 ACP 的 `native_tool_*` 并列，不改变工具语义。**这是本 ADR 唯一的协议增量。**

### D5.1 实现前先补的一个前置（2026-11-18 核实）

子进程**已经在发** oma 私有事件：`acp-mode.ts` 把 ACP 不认识的循环事件（delegation、mcp mounts、queue drain…）通过 `_oma/update` 自定义通知发出去（ADR 0039 rule 3）。

**但父端没有消费者**：`acp-backend.ts` 只 `onNotification(session.update)`，全仓 grep 不到 `_oma/update` 的处理。也就是说这条通道今天是**只写不读**的——在里面加 `job_state` 不会有任何效果。

因此实现顺序必须是：**先给父端接上 `_oma/update` 的处理，并做真机验证**，再往里加作业事件。

### D5.2 真机结论：通道**是通的**，是我读错了信封（2026-11-18）

第一次真机跑出 0 条 `job_state`，我判断「通道没送达」并回滚了父端接线。**这个判断是错的。** 加了两个临时探针（子进程发送处、父端处理器各一行 stderr）之后看到：

- 子进程在发：`sending _oma/update job_state`；
- 父端在收：`{"event":{"id":169,"type":"job_state","data":{"type":"job_state","jobId":"bg_1",...,"state":"started"}}}`。

通道一直通。真正的 bug：wire 上是运行时的**信封** `{id, type, data}`，而我的映射器从信封本身读 `jobId` —— 永远 undefined，于是每条都被当成「不认识的事件」丢掉。修法是先取 `event.data`（裸事件也接受）。

修好后真机落盘：

```
backend.acp.job_state {'jobId':'bg_1','jobKind':'bash','label':'sleep 30','state':'started'}
backend.acp.job_state {'jobId':'bg_1','jobKind':'bash','label':'sleep 30','state':'failed'}   ← 收尾时被杀，exit 137
```

**教训**：探针要同时打在发送方与接收方。只看到「数据库没有行」就断言通道不通，等于把「我的解析写错了」记成了「机制不可用」——这两件事的后续动作完全相反。

### D5.3 原始误判记录

按上面的顺序做了：

1. 子进程侧：注册表加 `onJobChange`（started/settled，`stopped` 映射成 `cancelled`，二次 settle 不重复触发），run-runtime 延迟绑定到会话 emit；单测 2 条通过。
2. 父端：注册 `_oma/update` 处理器 + `mapOmaUpdate` 纯函数 + 把 `backend.acp.job_state` 加进遥测白名单。
3. 隔离栈真机跑 `bash async=true`：**工具确实起了 job**（工具回执 "Backgrounded as job bg_1"，`hub` 查询到 `bg_1`），但 `agent_run_event` 里 **0 条 `job_state`**。

⇒ 子进程到父端这一段仍然不通。两个候选原因，**都未验证**：

- **信封形状**：父端读 `envelope.data`，而 `jobEvents.fn` 发的是裸 `OmaLoopEvent`（`{type, jobId, ...}`），`data` 为空；
- **自定义方法被 SDK 丢弃**：父端只声明了标准通知（`session.update`），自定义方法可能在校验层就被丢掉。

父端接线与遥测白名单**已恢复并通过真机验证**（见 D5.2）。仍待做的两件：

- **「打断」与「失败」要分开**：收尾时被杀现在报 `failed`（exit 137）；`bash` 工具把 `job.killed` 映射成 `failed`，改成 `stopped`（→`cancelled`）或单列 `interrupted` 即可；
- **不建表**：`agent_run_event` 已有 runId/type/data/ts，作业生命周期就是它的一类事件；原计划里的 `run_local_job` 表**取消**，「被打断」由「有 started、无终态」派生。

**这意味着 ADR 0063 D2 的表格化与 `interrupted` 标记仍未实现**；本 ADR 只完成到"子进程能报告"，并留下了否定证据。

## 不变量

1. **作业仍随 run 生死**（本 ADR 不改变这一点）；登记表只记录事实，不接管执行。
2. **打断必须被报告**，不允许静默消失：run 终态时仍在跑的作业，一律标 `interrupted` 并进入下一轮的上下文。
3. **重放只能是显式决定**，永不自动。

## 落点

| 层 | 文件 |
|---|---|
| 协议（前置） | `apps/backend/src/features/agent-run/acp/acp-backend.ts`：注册 `_oma/update` 处理器（当前为零），真机验证通道 |
| 协议 | `apps/oh-my-agent/src/core/coordination/registry.ts`（lifecycle 回调 → emit job 事件）、`event-mapping.ts` |
| 数据 | **不建表**：`agent_run_event` 复用为作业账本（runId/type/data/ts 已够） |
| 恢复 | `features/agent-run/execution-service.ts` 的 `recover()`：把 `interrupted` 写进 run 的终态上下文 |
| 提示 | 下一轮系统上下文里的"上一轮被打断的作业"段落 |

## 验收

1. 一个 run 起 `bash async` 后被杀：run 终态后 `run_local_job` 有一行 `interrupted`，且下一轮上下文含该作业的 label。
2. 正常结束的作业记 `finished`，不进打断清单。
3. 变异：把"终态时标 interrupted"删掉 → 测试红（否则登记表只是日志，不是事实）。
4. 明确的反向断言：**重启后不会自动重跑任何作业**（没有调度器在读登记表）。
