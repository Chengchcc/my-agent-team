# ADR 0059: 全双工执行循环 —— 可打断的监督

- 状态: Accepted（第 1–2 刀：循环层 + 双路回填；第 3 刀：`steer_worker` / `cancel_worker`。`wait_for` **刻意不做**：终态回填已经覆盖等待场景，它只会多一条阻塞面）
- 日期: 2026-11-17
- 相关: ADR 0047（房间派单）、ADR 0049（前台不变量）、ADR 0052（池化与回交）、ADR 0058（统一召回）

## 背景

DSH 的 Super Agent 把「全双工」和「插话」区分开：**插话解决消息能不能进来，全双工还要解决消息要等多久才被处理。** 模型循环是"推理 → 调工具 → 等结果 → 再推理"，只要一步卡在同步等待上，插话就只能排队——你说"先停"，也可能要等 20 分钟测试跑完。

我们的底座其实都在：steer 有队列并在步边界 drain；hub 有后台任务句柄；resume 能用新子进程续跑同一个 run。缺的是三处"最后一格"：

1. `waitEntries` 只等 job，**不等 steer**——等待中的 run 打不断；
2. 循环不看 `countRunningJobs()`——**模型一收尾，后台任务被杀**；
3. 工人 run 终态**不通知任何人**——前台既不能等也不能被叫醒。

## 决策

### D1 一切长等待都是 coordination entry

bash、eval、subagent、**等一个工人的 run**，进同一张注册表、同一个监督循环。`wait_for` 不是新机制，只是 `kind: "run"` 的条目，由后端在工人终态时喂终值。

### D2 一切"后端 → 活着的子进程"的唤醒都走 steer

人插话是 steer；**job 终结、工人终结也是 steer**。下行链路只有一条，capability 已在 ACP 握手上声明。不新增推送通道。

### D3 supervise：四源竞速的可打断等待

```
supervise() = race(
  任一 entry 终结,
  steerQueue 非空,
  取消,
  切片超时 ≤ 10s
)
```

`hub wait` 不再自己睡，改调它。**插话延迟因此有上界：一个切片。**

### D4 轮次结束的门槛改为"没有活、也没有话"

```
每步结束：
  有 steer       → drain，继续
  有 entry 在跑  → supervise（切片循环），结果注入下一步
  都没有         → 允许收尾
```

这是 DSH「后台工作占着 slot、不报告 waiting」的等价物。run 期间 job 一直活着，**不需要 job 跨进程存活**。

### D5 工人终态的双路通知

```
前台 run 活着 → steer 一条紧凑通知（不产生新 run）
前台不在等   → 排队输入，authorization = result:<workerId>
```

`result:` 与 `handback:` 对称；授权链不变量扩为 `dispatch: | handback: | result:` ⇔ 父链非空。**链深 ≤ 3**，防"前台派 → 工人报 → 前台再派"自我循环。

### D6 工具面（前台四个新动词 + 工人一个）

| 工具 | 谁 | 语义 |
|---|---|---|
| `wait_for({agent|runId, timeout})` | 前台 | 建 `kind:"run"` 条目；超时返回"还在跑"，不算失败 |
| `steer_worker({agent, message})` | 前台 | 复用 `execution.steer` |
| `cancel_worker({agent, reason})` | 前台 | 复用 `execution.stop` |
| `report({purpose, text})` | 工人 | purpose ∈ result / attention / answer；**只有 attention 立刻唤醒前台**；普通进度只落账 |

`report` 的纪律沿用原型：进度永不唤醒；前台对人**重写一条**通知，禁止转发、禁止逐点压缩。

### D7 护栏

| 护栏 | 值 | 防的是 |
|---|---|---|
| 切片 | ≤ 10s | 插话无上界 |
| 监督总预算 | 复用 30 分钟 wall-clock | 永不结束的 run |
| 每 run park | ≤ 8 | 无限续命 |
| 唤醒合并 | 同批终结一次 drain | 十个命令同时完 → 十次续跑 |
| 停止传递 | stop run → 停 entries → 杀进程组 | "run 停了命令还在跑" |

## 不做

- **持久化**（关机/重启后工作继续）。本设计里 job 随 run 生死；跨进程存活是"常驻"问题，另立 ADR。
- **按工具名做"5 秒转后台"**。改为工具声明 `blocking: fast | long`，运行时统一强制——新增长工具不需要改策略。
- **常驻子进程**。保住"一次性子进程、终态一次提交、崩溃可恢复"。

## 验收

1. job 在跑时模型收尾 → run 不终止（断言状态仍 running）；
2. `hub wait` 期间注入 steer → 在一个切片内被 drain（断言等待提前返回）；
3. 取消 → job 的进程组被杀（断言 entry = stopped）；
4. 不做 `wait_for`：终态 → steer 或排队输入 → 下一轮，已覆盖；
4b. ✓ `steer_worker` 重定向**正在跑**的工人（找不到活跃 run 即拒绝，不悄悄排队）；`cancel_worker` 需 reason、记录停的是哪个 run（各 2 条测试，变异 2 条）
5. ✓ 前台不在等 + 工人终态 → 排队输入 `authorization=result:<worker>`（`notify-dispatcher.test.ts`）
6. ✓ 工人 `report(progress)` → 只落账，前台不被唤醒；`report(attention)` → 前台被唤醒（两处各一条测试，变异验证：把 progress 也唤醒 → 红）
7. ✓ 链深第 4 层 → 拒绝唤醒、只落账（变异验证：去掉深度守卫 → 红）

## 落点

| 层 | 文件 |
|---|---|
| 循环（第 1 刀 ✓） | `apps/oh-my-agent/src/core/runtime/agent-loop-runner.ts`（hold、`job_result` 注入）、`coordination/registry.ts`（`waitInterruptible`：切片 + 100ms 唤醒轮询） |
| 工具（`report` ✓ / 三动词待做） | `apps/backend/src/features/product-tools/{manifest,dispatch,service}.ts` |
| 回填（第 2 刀 ✓） | `apps/backend/src/features/agent-run/notify-dispatcher.ts`（两条轨 + 深度护栏）、`bootstrap/features.ts`（`onRunCommitted`/`onRunFailed` 接线） |
| 文档 | `docs/architecture/runtime/oma.md`（监督一节）、`room-dispatch.md`（双路通知） |

## 后果

- 插话延迟从"命令时长"降到"一个切片"（≤10s）。
- 前台获得等、催、停三个控制动词；工人获得 result/attention/answer 的显式上报。
- 人看到的仍是前台重写的一句话，不是工人原文。
- job 仍随 run 生死——"合上电脑工作继续"不在本 ADR 范围。
