# Spec: Loop Feature 打磨 -- P0 阻断修复 + P1 信任建设 + P2 体验优化

> 状态：待评审
> 关联：ADR 0011（Web IA Work/Chat/Team）
> 设计约束：`docs/architecture/design-philosophy.md` -- 暴露业务、隐藏机制

## 1. 目标

修复 Loop feature 的 3 个阻断性问题 + 2 个信任建设 + 3 个体验优化，使其从"能创建但不能用"变为"可实际运行"。

## 2. P0: 阻断修复

### 2.1 STATE.md 双写竞态 -- HTTP 层改读 DB

**问题**：`loop-step.ts` 通过 `LoopStateStore.save()` 把 state 写入 `loop_item` DB 表。但 `http.ts` 的 `GET /api/loops/:id` 和 `GET /api/work/today` 还在读 `STATE.md` 文件（`parseStateMd(await Bun.file(...).text())`）。文件可能不存在、过期或未生成，导致用户看到的数据和实际不一致。

**修复**：
- `GET /api/loops/:id`：改用 `store.load(loopId)` 读 DB，删除 `parseStateMd` 文件读取
- `GET /api/work/today`：改用 `store.load(loopId)` 遍历所有 loop 的 `awaiting_review` items
- 删除 http.ts 中所有 `STATE.md` 文件读取
- STATE.md 不再是读路径的数据源（写路径如有需要可保留为导出物，但 HTTP 不依赖它）

**验收**：`GET /api/loops/:id` 和 `GET /api/work/today` 从 DB 读取数据，不读文件系统。STATE.md 不存在时返回正确数据。

### 2.2 手动添加 item -- API + 前端入口

**问题**：Loop 创建后 `loop_item` 表为空，`loopStep()` 只处理已有 `fixing` items。没有 API 让用户往 Loop 添加工作项。

**修复**：
- 新增 `POST /api/loops/:id/items`：body `{ source: string, summary: string, priority?: number }` -> 调 `loopReducer(state, { type: "ADD_ITEM", ... })` -> `store.save()`
- 返回 `{ item: { id, source, summary, step: "triaged", ... } }`
- 前端 Loop 详情页（`/work/[loopId]`）加"Add Item"按钮 + 表单弹窗

**验收**：POST 创建 item 后，`GET /api/loops/:id` 返回的 items 列表包含该 item。前端可添加、查看。

### 2.3 Generator prompt 注入项目上下文

**问题**：`buildGeneratorPrompt(item, template)` 只把 `item.summary` 塞进模板。Generator agent 拿到一句摘要，没有项目背景、代码库结构、约束信息，大概率产出无关改动。

**修复**：
- `buildGeneratorPrompt` 扩展：注入 repo 路径、最近 git log（5 条）、项目名
- prompt 结构：`{systemPrompt}\n\n## Project Context\n- Repo: {repoPath}\n- Recent changes:\n{gitLog}\n\n## Task\n{item.summary}\n\n{template}`
- git log 通过 `gitRunner.revParse` + `git log --oneline -5` 获取（复用已有 gitRunner 接口）

**验收**：Generator session 收到的 prompt 包含项目上下文。`loopStep` 测试验证 prompt 结构。

## 3. P1: 信任建设

### 3.1 Evaluator 兜底 -- 超时 + 降级 verdict

**问题**：Evaluator 崩溃或没写 VERDICT.md 时，`loopStep` 默认 ESCALATE。没有超时机制，Evaluator 可能卡住整个 Loop。

**修复**：
- `loopStep` 里 Evaluator session 加超时：`Promise.race([session.prompt(...), timeout(60_000)])`
- 超时或崩溃时 verdict 降级为 `{ verdict: "ESCALATE", reasons: ["Evaluator timeout/crash"], evidence: "" }`（当前行为）+ 记日志
- 增加 Evaluator 结果为空时的更明确日志：`console.error("[loop] evaluator produced no verdict for item ${item.id}")`

**验收**：Evaluator 超时/崩溃时 item 进入 inbox（ESCALATE），Loop 不卡住。

### 3.2 预算超限通知

**问题**：`dailyCap` 超限后 `loopStep` 静默 `break`，用户不知道 Loop 今天已停。

**修复**：
- 超限时向 Loop 的 conversation ledger 写一条系统消息：`[系统] Loop 今日预算已耗尽（{spent}/{cap}），暂停执行，明日自动恢复。`
- 复用现有 `convPort.appendLedgerEntry`（如果有 conversation 绑定）

**验收**：预算超限后 conversation ledger 有系统消息。

## 4. P2: 体验优化

### 4.1 运行历史视图

**问题**：Loop 详情页只显示 `lastRun` 和当前 items。没有历史运行数据。

**修复**：
- `GET /api/loops/:id` 返回新增 `budgetHistory` 字段：最近 7 天的 `{ date, spent }` 数组（从 `loop_budget` 表查）
- 前端 Loop 详情页加一个"Budget History"卡片（简单柱状图或列表）

### 4.2 Review 动作反馈

**问题**：用户 approve/reject 后没有明确反馈。

**修复**：
- `POST /api/loops/:id/review` 返回 `{ state, action: "approved" }` 明确标记动作类型
- 前端 review 后 toast 提示 + 列表更新

### 4.3 Loop 列表状态指示

**问题**：`GET /api/loops` 只返回 cron job 列表，不包含 awaiting_review 状态。

**修复**：
- `GET /api/loops` 每个 loop 加 `pendingCount` 字段：该 loop 的 `awaiting_review` item 数量
- 前端 Loop 列表卡片显示 badge（如"3 待审"）

## 5. 不做的事

- 不做 STATE.md 导出（写路径保留但 HTTP 不依赖）
- 不做多 Loop 协调
- 不做 Loop 之间 item 移动（promote 跨 loop）
- 不做 Evaluator 浏览器验证（Phase 2）
- 不做 SSE 实时进度推送（Phase 2）

## 6. 验收标准

1. `GET /api/loops/:id` 和 `GET /api/work/today` 从 DB 读取，不读 STATE.md 文件
2. `POST /api/loops/:id/items` 创建 item，`GET /api/loops/:id` 返回的 items 包含它
3. Generator prompt 包含 repo 路径 + git log
4. Evaluator 超时/崩溃时 Loop 不卡住
5. 预算超限时 conversation ledger 有系统消息
6. `GET /api/loops` 返回每个 loop 的 `pendingCount`
7. `GET /api/loops/:id` 返回 `budgetHistory`
8. 前端有 Add Item 入口 + Review 反馈 + Loop 列表状态 badge
9. typecheck + test + lint 全绿
