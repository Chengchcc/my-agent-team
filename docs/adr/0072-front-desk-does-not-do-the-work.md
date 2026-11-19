# ADR 0072: 前台不干活，写入有围栏，共享目录要显式

- 状态: Accepted（D1/D2 已实现；D3 是既有能力，本轮明确为唯一共享机制）
- 日期: 2026-11-19
- 相关: ADR 0019/0020（agent workspace）、ADR 0023（project worktree）、ADR 0049（前台不变量）、ADR 0056/0057（选人与前台纪律）

## 背景

两件事在真机上同时暴露：

1. **前台自己把活干了。** decision corpus（`scripts/front-desk-decisions.ts`）里三条"是活不是问句"的用例，前台没有派发，而是**直接改了 `worker-one` 的文件**：
   - 第一轮用 `bash`（`pwd; ls; …` 然后写文件）；
   - 我们把 `bash/write/edit` 从它的工具集里拿掉之后，它改用 **`eval`**（任意 JS + `node:fs`）写同一个文件。
2. **写入没有围栏。** 任何 agent 都能用绝对路径写**别人的**工作区：`ingest` 里那个 `glob` 反而被拒（`cwd escapes workspace root`），说明读有边界、写没有。

所以"前台是路由者"（ADR 0049 的意图）此前只靠提示词，而**能力上它是全能的**。

## 决策

### D1 写入默认围栏：只能写自己的 cwd

`OMA_ALLOW_WRITE_PATHS` 现在**永远**包含 run 自己的 workspace（带结尾分隔符，按子树匹配），再并上 agent 显式配置的 `allowWritePaths`。

工具层语义（`file-tools.ts`）：`allow` 非空 ⇒ 该列表之外一律拒绝；`deny` 永远优先。于是"没配策略"不再等于"想写哪写哪"。

### D2 角色决定工具，而不是提示词

前台（`role !== "worker"`）的 run 冻结 `toolPolicy.disabledTools = ["bash","eval","write","edit"]`；子进程读到 `OMA_DISABLED_TOOLS` 后**根本不挂载**这些工具（`agent-loop-runner` 过滤）。

保留：`read`/`ls`/`glob`/`grep`/`tree`（调查）、`web_*`、以及产品工具（`dispatch`/`ask`/`report`/`todo`/`history`）。
工人不限制。

**为什么包含 `eval`**：它是实测的第一个逃逸口。任何"能跑任意代码"的工具都等价于写权限，禁写必须一起禁。

### D3 共享目录 = 显式 grant，默认隔离

"两个 agent 共享一个目录"不是默认行为，而是**配置动作**：把该目录写进 agent 的 `allowWritePaths`。默认状态下，A 写不进 B 的 workspace。

这与 ADR 0023 的分工一致：**共享工作**的本义由 project worktree 承担（每 (agent, project) 一个 worktree、靠分支合流）；共享**目录**是例外，需要显式声明，且并行 run 之间没有隔离——写进配置的人要自己承担这一点。

## 不变量

1. 一个 run 默认只能写自己的 cwd（加上它的显式 grant）；跨 agent 写入需要两边都显式配置。
2. 前台没有写/执行类工具，因此不可能"自己把活干了"——它只能派发。
3. 能力（工具集）由角色在 run 创建时冻结，运行中不可变。
4. `deny` 列表永远压过 `allow`。

## 落点

| 层 | 文件 |
|---|---|
| 写入围栏 | `features/agent-run/acp/acp-backend.ts`（`writeAllowList`，env `OMA_ALLOW_WRITE_PATHS`） |
| 工具能力 | `bootstrap/features.ts`（按角色冻结 `disabledTools`）、`protocol/history.ts`（冻结字段）、`core/runtime/agent-loop-runner.ts`（`OMA_DISABLED_TOOLS` 过滤） |
| 度量 | `scripts/front-desk-decisions.ts` + `.cases.json` |

## 验收

1. ✓ `writeAllowList`：cwd 永远在内且带分隔符；显式 grant 被并入；**兄弟工作区不在内**（单测）。
2. ✓ 禁用列表随 run 冻结并交给子进程（单测：`OMA_DISABLED_TOOLS=bash,write,edit`）。
3. 进行中的真机复核：同一句"是活"的话，前台应当**派发**而不是自己写。

## 未做（如实记录）

- `bash` 以外的沙箱级写阻断（bwrap 写挂载）没有做：`disabledTools` 是**工具层**边界，一旦某个工具能绕道执行代码（历史上是 `eval`），就必须连带禁用；这条教训已写进 D2。
- 前台仍可读别的 agent 工作区（`read`/`ls` 的边界由各自工具决定）——读权限不是本轮目标。
