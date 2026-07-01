# PRD: Loop — 统一工作系统

## 问题陈述

my-agent-team 产品当前有两套工作系统：`/conversations` 对话，`/issues` Kanban。两套心智模型、两套 UI、两套执行引擎（Orchestrator + ColumnConfig vs. 裸 AgentSession dispatch）。具体痛点：

**1. 手动工作依赖人创建和推进。** 工程师想做"每天早上检查 CI 失败，自动修简单的"，要么每天手动做，要么配一个 CronJob 触发裸 agent——没有 discovery 阶段、没有结构化输出、没有 verification 分离、没有 review queue。CronJob 只有一个 `prompt` 字段和一个 `agentId`（参见 `docs/architecture/foundations/cron-job.md`）。它表达不了"先发现需要做什么，再修复，再验证，最后问我"。

**2. Issue/Kanban 模型太定制化。** 假设了 planner → developer → reviewer 的代码修复流水线（参见 `docs/architecture/foundations/issue-workflow.md`），带 per-column agent 配置（`docs/architecture/backend/orchestrator.md` 的 ColumnConfig）。但"给新 issue 打标签""从合并的 PR 生成 release notes""提醒 stale PR 的 reviewer"这些场景塞不进 planner/dev/reviewer 模子。

**3. 两套系统要分别学。** 用户学 Kanban 流（draft → planned → in_progress → in_review → done，ColumnConfig，Orchestrator 转移表，`in_review` 闸门），又单独学 CronJob（cron 表达式，agentId，prompt，超时，重试）。两者不共享执行基础设施、UI 模式、概念模型。

根本问题：**没有一个统一概念来表达"需要做的工作"，不管它是人想到的还是 cron 发现的。**

## 解决方案

Loop 是统一的工作概念。它用一个模型取代 Kanban Issue 流程和裸 CronJob dispatch：**Loop 发现工作、执行、验证、暂停等人判断。** 手动工作池就是一个没有 discovery 阶段和 schedule 的 Loop——人往里加 item，同一套 act/verify/judge 流水线照样跑。

### 对用户的变化

- `/issues` 作为顶级导航消失。`/loops` 是唯一工作入口，和 `/conversations` 并列。
- 创建工作不再是表单式（选 project、填 title、拖 column）。是意图式："每天早上检查 CI 失败，自动修简单的"。系统解读意图，生成 Loop 配置，用户预览确认。Goal 是创建对话框里的过渡态——Loop 创建后消失（参见 `CONTEXT.md` § Loop）。
- 审批工作不再分裂在 Kanban `in_review` 列和别的地方。所有等人判断的 item——无论来自自动 Loop 还是手动工作池——都在 Loop 详情页的同一个 review queue 里。
- 已有 Issue/Kanban 系统过渡期间保持只读（参见 `docs/architecture/foundations/issue.md`，已标记"将被 Loop 吸收"）。完整迁移不在本 PRD 范围。

### 架构变化

- **Loop item 不进数据库。** Item 在 STATE.md 文件里——人类可读、可移植、零 schema migration。Loop 配置在文件系统 `.loop/` 目录里。唯一 DB 改动：`cron_job` 表加 `loop_config_path TEXT`（可为 null）。
- **CronJob 调度 Loop，不是反过来。** CronJob 持有 cron 表达式，到点调 `loopStep(loopConfigPath)`（参见 `docs/architecture/foundations/cron-job.md`）。Loop 不持有 schedule 字段。手动 Loop 没有 CronJob——直接通过 API 调 `loopStep`（参见 `docs/architecture/backend/loop-runner.md`）。
- **Goal 不是领域实体。** 它是创建对话框里的自然语言输入，翻译成 Loop 配置后丢弃——就像 Issue 创建表单不持久化一样（参见 `CONTEXT.md` § Loop vs agentLoop）。

## 用户故事

### 创建——"我想要一个能做 X 的东西"

1. 作为工程师，我想用自然语言描述我的自动化意图（"每天早上检查 CI 失败，自动修简单的"），这样我不需要学 cron 语法、skill 名称、安全配置。
2. 作为工程师，我想让系统解读我的意图并展示它会配什么——schedule、discovery 范围、generator 和 evaluator 配置、安全约束、budget cap——这样我可以在激活前预览和调整。
3. 作为工程师，我想手动调整任何生成的设置（换 evaluator model、加 denylist 路径、改 retry 上限、调 budget cap），这样我对安全关键参数保留控制权。
4. 作为工程师，我想创建一个手动工作 Loop——没有 schedule、没有 discovery——我可以一个个往里加 item，系统照样跑 generator → evaluator → 我审批，这样临时任务也能享受和自动化 Loop 一样的流水线。

### 仪表盘——"发生了什么？"

5. 作为工程师，我想在一个视图里看到所有 Loop，每个显示等待审批的 item 数、今日 token 消耗相对预算的比例、上次运行时间，这样我不用点进去就知道哪些 Loop 需要关注。
6. 作为工程师，我想一键暂停/恢复 Loop，这样我可以随时停止自动化而不删除配置。
7. 作为工程师，我想手动触发一次 Loop 运行而不等下次 cron tick，这样编辑配置后可以立即验证。
8. 作为工程师，我想删除不再需要的 Loop，这会归档 `.loop/` 目录并删除对应 CronJob，这样死 Loop 不会堆积在仪表盘上。

### Review Queue——"什么需要我判断？"

9. 作为工程师，我想看每个等待审批的 item 的完整证据链——原始发现（从哪来的、为什么重要）、generator 的改动（diff、改了哪些文件、尝试了几次）、evaluator 的判定（测试输出、scope check、截图）——这样我可以不用离开页面就做出知情的 approve/reject 决定。
10. 作为工程师，我想在 review card 里展开 generator 的 diff 看具体改了什么，这样不用打开外部工具就能审代码。
11. 作为工程师，我想看 evaluator 的证据：实际测试命令输出（不是只写"tests passed"）、scope check 结果（改了哪些文件、是否触碰 denylist 路径）、evaluator 的置信度——这样我可以判断 evaluator 的 "PASS" 是严格审查了还是走过场。
12. 作为工程师，我想一键 approve 一个 item，它标记为 resolved 并从 review queue 清除，这样通过的工作不堆积。
13. 作为工程师，我想 reject 一个 item 并附带反馈（"这只修了表象，没解决根因"），它进 inbox 等以后再看，这样我不丢掉发现但也不让有问题的改动通过。
14. 作为工程师，我想把一个 item 从 review queue promote 到更深入的工作流——创建一个多 agent 对话，或加到另一个手动工作 Loop——这样复杂问题不阻塞 review queue，得到应有的关注。
15. 作为工程师，我要 review queue 是统一的视图，不管 item 从哪来（自动 Loop discovery、手动工作池、从另一个 Loop promote），这样不用在多个地方检查需要我判断的东西。

### 运行历史——"发生过什么？"

16. 作为工程师，我想看每个 Loop 运行的时间线——8:03 这次运行，discovery 发现 3 个 item，generator 修了 2 个，evaluator 拒了 1 个（scope drift），1 个等审批——这样我可以审计 Loop 的时间行为。
17. 作为工程师，我想点进某次运行看每个 item 在当次运行中的完整生命周期——discovery 发现了什么、generator 产出了什么、evaluator 判了什么、我决定了什么——这样我追查任何发现的完整历史。
18. 作为工程师，我想在运行历史里看到 post-run critique：哪些发现是误报、哪些该降优先级、Loop 操作者对 discovery 质量的备注。这让我逐步调优 Loop 的 discovery skill。

### 安全与成本——"别让它失控"

19. 作为工程师，我想给每个 Loop 设置每日 token 预算上限，这样如果 bug 导致 Loop 整夜空转同一个 finding，到上限就停而不烧光配额。
20. 作为工程师，我想要 Loop 在消耗达到每日预算 100% 时自动暂停、达到 80% 时告警，这样还没到上限我就知道出问题了。
21. 作为工程师，我想要路径黑名单在 generator 和 evaluator 层面强制执行——匹配 `.env`、`auth/`、`payments/`、`secrets/` 等模式的文件绝不修改——这样安全敏感代码永远不会被自动编辑，不论 discovery agent 发现了什么或 generator 建议了什么。
22. 作为工程师，我想要 auto-merge 默认为 "never"，由我配置显式 allowlist（如"docs/ 下的 typo 修复可以"），这样没有我的明确审查，任何代码都不会推送到仓库，除非我专门为那类改动放行。
23. 作为工程师，我想要每个 Loop 有最大重试次数（默认 3）——如果 evaluator 连续拒同一个修复 3 次，item 进 inbox 而不是无限循环，这样难题不会变成死循环。

## 实现决策

### Loop 不进数据库——配置在文件，item 在 STATE.md

这是最重要的架构决策。在研究了 loop-engineering 参考仓库（Cobus Greyling，`/root/loop-engineering/`）并对 my-agent-team 已有架构进行 grilling 后，结论是：**Loop 不应该增加新数据库表。**

原因：
- Loop 配置（model 选择、skill 引用、安全约束、budget cap）很少变，且适合人类可读和版本控制。`.loop/config.yml` 文件满足两者。
- Loop item（discovery 的"发现"）本质上是临时的，适合人类可读。写入 STATE.md 使其可移植、任何编辑器可调试、零 schema migration。
- loop-engineering 参考仓库已在大规模验证此模型：Loops 读写 STATE.md，文件同时是运行时状态和审计日志。
- CronJob 是唯一的数据库接触点。在已有 `cron_job` 表加一列（`loop_config_path TEXT`）就把调度基础设施连到了文件型 Loop 世界。

参见 `CONTEXT.md` § Loop、`docs/architecture/foundations/loop.md`。

### CronJob 调用 Loop，不是反过来

CronJob 是已有领域实体（`docs/architecture/foundations/cron-job.md`，`status: design`），处理 cron 表达式解析、`Bun.cron` 注册、超时、重试、dispatch。Loop 是被调度的东西。CronJob 的 handler，当 `loop_config_path` 有值时，调 `loopStep(loopConfigPath)` 而不是 dispatch 裸 AgentSession。手动 Loop 没有 CronJob——通过 API 直接调。

这避免了在 Loop 里重复发明调度逻辑（cron 解析、时区处理、进程生命期、重试、超时）。CronJob 拥有调度；Loop 拥有 discovery + 执行 + review。

### Generator 和 Evaluator 是结构分离的不同 AgentSession

这是一条第一性原理决策，源于 Anthropic 的 generator/evaluator 模式（Prithvi Rajasekaran, 2026）。核心洞见：让 agent 给自己的产出打分，它会自信地夸奖——因为上下文窗口里塞满了导致产出的自我说服链条。调校一个独立怀疑者远比让 generator 对自己作品持批判态度可行。

实现：Generator 和 Evaluator 使用不同 `AgentSession` 实例、不同 `sessionId`，**必须**使用不同 model（参见 `docs/architecture/harness/harness.md`）。Evaluator 的 system prompt 默认怀疑立场："ASSUME this code is BROKEN until proven otherwise. DO NOT praise. Run tests, check scope, report real output." Evaluator 通过 MCP connector 执行测试和操作页面来验证，不只读代码。

Stop condition 由第三个新鲜模型判断——既不是 generator 也不是 evaluator。

参见 `docs/architecture/backend/loop-runner.md`。

### Item step 状态机——来自 prototype

Item 通过一个固定的六步流水线，经过交互式终端原型验证（`prototypes/loop-step/`，已删除）：

```
triaged → fixing → verifying → awaiting_review
                                    ├─ resolved  (人通过)
                                    ├─ inbox     (人拒绝或重试耗尽)
                                    └─ promoted  (人送更深工作流)
```

关键转移：
- `triaged → fixing`：TICK 动作（cron 触发或手动）。启动 generator AgentSession。
- `fixing → verifying`：Generator 完成。隐式——启动 evaluator AgentSession。
- `verifying → awaiting_review`：Evaluator 通过。Item 等人。
- `verifying → fixing`：Evaluator 拒绝，attempt < maxRetries。Generator 带拒绝理由重跑。这是结构性的 retry——不同于 Orchestrator 的 `in_review → in_progress` 人工驳回回路（参见 `docs/architecture/backend/orchestrator.md` § ⑥ 人工验收闸门 + 返工）。
- `verifying → inbox`：Evaluator 拒绝且重试耗尽。挂起等人工跟进。
- `awaiting_review → resolved/inbox/promoted`：人决定。

Terminal step（`resolved`、`inbox`、`promoted`）的 item 下次 TICK 时从 STATE.md prune 掉。

纯 reducer `loopReducer(state, action) → state` 是单一测试 seam。编码所有转移，可无 I/O、无 AgentSession mock 测试。

### loopStep()——生产入口函数

不是连续异步生成器。每次 trigger（cron tick 或人 review）调一次：

1. 读 STATE.md 和 `.loop/config.yml`
2. TICK：`triaged` item 推进到 `fixing`，启动 generator AgentSession
3. 对 generator 完成的 item：启动 evaluator AgentSession
4. 对人 review action：对指定 item 应用 approve/reject/promote
5. 写回 STATE.md

Human gate 靠 STATE.md 文件持久化跨进程重启。人几小时或几天后审批；一次新的 API 调用到达；`loopStep()` 读文件从上次中断处继续。不需要内存状态。

参见 `docs/architecture/backend/loop-runner.md`。

### Discovery 通过 MCP connector

Discovery 是一个普通 AgentSession 调用，配上特定 skill（如 `loop-triage`）和 MCP connector 工具（读 CI、issues、commits）。Agent 通过 fs-memory plugin 读上次 STATE.md（参见 `docs/architecture/plugins/fs-memory.md`），调 MCP 工具收集数据，把 finding 写成结构化 markdown 表格写回 STATE.md。

Discovery 质量决定了整个 Loop 的上限。Discovery agent 被约束：NEVER edit code、NEVER create commits、ONLY read sources and write to STATE.md。来自 `loop-constraints.md` 的约束注入 system prompt。

### 自然语言创建

Loop 创建是一个对话框，不是表单。用户输入"每天早上检查 CI 失败，自动修简单的"。系统调 intent-to-config 翻译器（一次 LLM 调用），把意图映射为：schedule（cron）、discovery skill、generator/evaluator model 和 prompt、安全约束、budget cap。用户看到预览，可调整任何字段再激活。

参见 `docs/architecture/foundations/loop-pattern.md`（7 种内部模板驱动翻译器）。

### 模块架构——两个深模块

依循 codebase-design 原则（小接口、大实现、通过接口可测试）：

1. **LoopRunner**（深模块）——接口：`loopStep(configPath, action?) → StepResult`。隐藏全部 discovery → generator → evaluator → human gate 编排。依赖 AgentSessionFactory（注入，不内部创建）、StateFileManager、BudgetGuard。

2. **StateFileManager**（深模块）——接口：`read(path) → LoopState`、`write(path, state)`、`prune(path)`。隐藏 markdown 表格解析、序列化、状态规范化。纯 I/O，不依赖 agent。

BudgetGuard 是中深度模块：`check(loopId) → "ok" | "warn" | "stop"`。

### API 端点

```
POST   /api/loops              创建 Loop（从自然语言意图）
GET    /api/loops              列出所有 Loop 及汇总统计
GET    /api/loops/:id          Loop 详情：配置 + review queue + 运行历史
PATCH  /api/loops/:id          更新 Loop 配置
DELETE /api/loops/:id          删除 Loop + 归档 .loop/ 目录
POST   /api/loops/:id/run      手动触发
POST   /api/loops/:id/review   人审批操作（approve/reject/promote item）
GET    /api/loops/:id/events   SSE 实时进度流
POST   /api/loops/:id/items    向手动 Loop 添加 item
```

### Web 路由

```
/loops                  仪表盘
/loops/:id              详情（review queue + 运行历史）
```

Loop 创建是仪表盘上的 dialog/modal，不是独立路由。

## 测试决策

### 什么算好测试

测纯 reducer，不测文件 I/O 包装或 AgentSession 内部。给定 LoopState 和 Action，断言产出正确的 LoopState。不 mock，不 async，无外部依赖。

### 测试 seam

单一 seam：`loopReducer(state, action) → state`——来自 prototype 的纯函数。测试覆盖：

- TICK：triaged item 推进到 fixing
- Evaluator PASS：verifying → awaiting_review
- Evaluator REJECT（retry < max）：verifying → fixing
- Evaluator REJECT（retry = max）：verifying → inbox
- 人 approve：awaiting_review → resolved
- 人 reject：awaiting_review → inbox
- 人 promote：awaiting_review → promoted
- 非法转移被拒绝（如对 fixing item approve 是 no-op）
- Prune：resolved/inbox/promoted item 被移除

### 测试先例

`packages/framework/src/create-agent.test.ts`——scripted 输入，asserted 输出。Loop reducer 测试遵循相同模式但更简单：纯函数、同步、不依赖模型。

## 范围外

- **已有 Issue 数据迁移到 Loop 格式。** Issue 过渡期间保持只读。迁移路径由后续 PRD 处理。
- **Loop 内多步 Orchestrator 工作流。** 从 Loop promote 的 item 进入另一个 Loop 或创建 Conversation。已有 Orchestrator（planner → developer → reviewer + ColumnConfig）不在 Loop 内重建（参见 `docs/architecture/backend/orchestrator.md`）。
- **Loop 模板市场或社区共享。** 7 种内部模板驱动 intent-to-config 翻译器。没有面向用户的 pattern 浏览器。
- **自动 git worktree 管理。** Generator AgentSession 使用调用方的工作目录。隔离是调用方的责任。
- **多 Loop 协调或 finding 去重。** Loop 独立运行。
- **Loop Ready Score 首期发布。** 评分概念（来自 loop-engineering 参考仓库）推迟到后续 PRD。

## 补充说明

### 产品简化是关键赌注

移除 `/issues` 并将一切统一到 `/loops` 是本 PRD 最大的产品决策。它消除了"自动工作"和"手动工作"之间的认知分裂。用户不学两套系统。学一个 Loop、一个 review queue、一种做判断的方式。

### 文件型 state 是刻意的

STATE.md 代替数据库表不是偷懒——是设计选择。文件可移植（复制 `.loop/` 到另一个项目）、人类可读（任何编辑器打开）、无 schema（item 格式演进不需要 migration）。loop-engineering 参考仓库已验证此方法：STATE.md 同时是运行时状态、审计日志、人类可读报告。

### 设计渊源

本设计受以下启发：
- Loop Engineering 概念（Peter Steinberger, Boris Cherny, Addy Osmani, 2026-06）
- loop-engineering 参考仓库（Cobus Greyling，`/root/loop-engineering/`）——patterns、skills、STATE.md 约定、安全模型
- Generator/Evaluator 分离发现（Prithvi Rajasekaran, Anthropic, 2026）
- Stripe Minions 流水线（Steve Kaliski, 2026）——确定性闸门与 LLM 步骤交错
