# ADR 0028: TUI 组件分层——live 归 chrome，终局归 transcript

## 状态

Accepted(2026-09-14)

## 背景

oma TUI 有两个渲染区域，长期没有明确的归属规则：

- **transcript**：append-only，committed 行进 native scrollback 后不可重写；
  item settle 后不可变；是 session 回放(resume/fork)的事实记录。
- **chrome**：pinned 在 editor 上方，每帧重绘，不进 scrollback，无持久化语义。

task(批量 subagent 委派)暴露了规则缺位的后果：

1. **transcript 里的 live 行僵死**：每个 subagent 的活动行(`⚙ label · tool`)
   是 transcript status item，由事件驱动原位更新。事件间隙(subagent 跑长工具)
   没有任何东西调 `requestRender`——shimmer 只在事件到达时跳帧，用户看到
   "卡住的动画"。而 transcript 不敢加定时重绘：committed 前沿约束下，任何
   定时改写都可能污染 scrollback(前两轮 TUI 闪烁 bug 的形态)。
2. **task 工具盒是空壳**：streaming 期间只有 `⟳ running…`，batch 里有哪些
   agent、各自任务是什么(`item.input.tasks` 里的现成信息)不可见。
3. **三层冗余**：空壳盒子、`[delegating: task (5 agents)]`、每 agent 一条
   live 行——语义重叠但都回答不了"现在在干什么"。

todo 已隐式示范正确模式：live 快照渲染为 chrome，settle 后组件消失，transcript
安静。本 ADR 把它升格为所有组件的显式规则。

## 决策

### 分层原则

**主流程之外异步执行、但用户需要了解进度的东西，live 状态渲染在 chrome；
结果落在 transcript。** 两区各司其职：

| | chrome | transcript |
|---|---|---|
| 生命周期 | 随 activity 存在，结束即消失 | 永久(session 回放的事实记录) |
| 重绘 | 每帧自由重绘(无 scrollback 语义) | append-only，settle 后不可变 |
| 驱动 | repaint driver 定时刷新 + 事件 | 事件驱动(commit 边界随 streaming item) |
| 内容 | 进行时(进度、当前动作、计数) | 完成时(结论、终局标记、错误) |

### 决策树(新组件/新信息往哪放)

```
这条信息在活动结束后还需要被看到吗?(resume 回放、翻历史)
├─ 否 → 它是过程,放 chrome:
│        是主流程外的异步活动吗?(subagent/bg job/长工具)
│        ├─ 是 → chrome pinned 块:
│        │        · live 活动行(每 worker 一行,原位更新)
│        │        · shimmer 动画(chrome 有 repaint driver,平滑)
│        │        · 活动结束:行消失,终局标记落 transcript(见下)
│        └─ 否(纯瞬态,如 quit 提示) → status 区临时行
│
└─ 是 → 它是结果,放 transcript:
         · 工具盒 settle 后落结果树(✔/✗ + 结论预览)
         · 终局状态行(`✔ label` / `delegating:` / `delegation done`)
         · streaming 期间盒子本体渲染空(不建 group,不占 scrollback)
```

判定口诀:**"结束还看吗"切 transcript/chrome,"异步吗"决定 chrome 块的形态。**

### chrome 区配 repaint driver

busy 期间一个 interval(100ms)调 `tui.requestRender()`。chrome 没有 scrollback
语义，定时重绘零风险——这是 transcript 区不敢加 timer 的根本原因，chrome 没有
这个约束。driver 顺带救活 chrome 内所有动画(shimmer/spinner)。

### 既有组件对号

| 组件 | 归位 | 说明 |
|---|---|---|
| todo 快照 | chrome-only(已是) | 先例，不动 |
| task 的 live agent 行 | chrome(本 ADR 从 transcript 迁入) | `TuiViewState.liveAgents` state 级 Map |
| task 终局结果树 + ✔/✘ 标记 | transcript(不动) | resume 回放保留结论 |
| `delegating:`/`delegation done` 状态行 | transcript(不动) | 持久记录 |
| hub wait 的 500ms 快照 | transcript 工具盒内 | 走 `onOutput → item.output`，盒子在视口内随事件重绘，非长驻 chrome 候选 |
| hub jobs/output/steer/stop | transcript 工具盒 | 一次性调用，无 live 期 |
| bash 同步长命令 | transcript 工具盒内 live 尾窗 | 同上 |

## 后果

- 正面：task 执行期间用户始终看到 pinned 实时活动清单；task 盒子 settle 后
  才有内容，transcript 无空壳无冗余；chrome 区动画平滑。
- 负面/接受的代价：
  - **live 过程行不持久化**——resume 回放只有 ✔/✘ 终局标记，没有过程。
    与 todo 同款权衡：过程是瞬态的，结论才是记录。
  - `TuiViewState.liveAgents` 从 `RunViewState` 提升到 state 级——跨 run
    的孤儿 live 行由 batch settle 清理兜底。
- 受影响面：view-state 的 delegation 分支、tui-frame-provider 的 chrome 组装、
  tui-io 的 busy lifecycle(挂 interval driver)、tui-tool-render 的 task 盒子。
  测试契约：`tui-mode.test.ts` 的"一个 agent 一行 settled marker"断言保持
  (终局标记仍在 transcript)。
