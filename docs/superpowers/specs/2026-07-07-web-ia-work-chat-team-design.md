# Spec: Web IA 重组 — Work / Chat / Team / System

> ADR: [0011](../../adr/0011-web-ia-work-chat-team.md) · 2026-07-07

## 1. 目标

把 Web 信息架构从"模块地图"翻译成"用户意图地图"：收敛为 3 个一级心智 + 1 个低调系统区（Work / Chat / Team / System）。Issue 在前端退役，Loop 承接工作单元语义并升为默认落地页。

## 2. 范围

**全量 spec**，包含：
- 路由树重组（目录搬迁）
- Issue 前端退役（已完成大部分，清理残留）
- Work 新页面（Today + New 对话向导）
- Chat 总览页 + 默认 Agent
- 可观测性下沉（ops 拆解到 work/system）
- NavRail 重写
- 后端新增 2 个读 API + 默认 Agent seed
/work/[loopId]/runs/[runId] 单次运行详情（收编原 /ops/sessions/[id]；runId = spanId）
**不做**：
- 不改后端 Loop/Cron 领域模型与 API 契约
- 不做旧 URL 重定向（旧路由直接 404）
- 不物理下线后端 Issue 表（独立迁移）
- 不加 `isDefault` 字段（seed 固定默认 Agent）

## 3. 实现路径

Next.js App Router 目录搬迁——目录名与 URL 天然对齐。

## 4. 目标路由树

```
/                          redirect → /work
/login

# ① WORK（承接 Loop）
/work                      Work Today：awaiting_review item 队列 + 运行/预算概览
/work/[loopId]             Loop 详情：item 列表 + 证据链 + 人审动作
/work/[loopId]/runs/[runId] 单次运行详情（收编原 /ops/sessions/[id]；runId = spanId）
/work/new                  AgentSession 对话向导，用 loop-config-generator skill 生成配置

# ② CHAT（以会话为根）
/chat                      会话总览：跨 Agent 最近会话
/chat/[conversationId]     会话画布

# ③ TEAM（Agent 同事）
/team                      Agent 花名册（含就绪状态）
/team/[agentId]            单 Agent：Persona + Skill Packs + 最近运行
/team/skills               Skill Pack 分发
/team/projects             Project 工作归属域

# ④ SYSTEM（低调）
/system                    Surface 健康 + 全局 trace 检索
```

## 5. 目录搬迁映射

| 原目录 | 新目录 | 动作 |
|--------|--------|------|
| `app/(main)/loops/page.tsx` | `app/(main)/work/page.tsx` | 删除，被新 WorkTodayPage 替代 |
| `app/(main)/loops/[id]/page.tsx` | `app/(main)/work/[loopId]/page.tsx` | 搬迁 |
| `app/(main)/loops/new/page.tsx` | `app/(main)/work/new/page.tsx` | 删除，被 AgentSession 对话向导替代 |
| `app/(main)/conversations/[id]/page.tsx` | `app/(main)/chat/[conversationId]/page.tsx` | 搬迁 |
| — | `app/(main)/chat/page.tsx` | 新增：会话总览 |
| `app/(main)/agents/page.tsx` | `app/(main)/team/page.tsx` | 搬迁，合并 ops/agents |
| `app/(main)/agents/[id]/page.tsx` | `app/(main)/team/[agentId]/page.tsx` | 搬迁，加最近运行 |
| `app/(main)/skill-packs/page.tsx` | `app/(main)/team/skills/page.tsx` | 搬迁 |
| `app/(main)/projects/page.tsx` | `app/(main)/team/projects/page.tsx` | 搬迁 |
| `app/(main)/ops/page.tsx` | 删除 | run 列表搬入 /system |
| `app/(main)/ops/sessions/[id]/page.tsx` | `app/(main)/work/[loopId]/runs/[runId]/page.tsx` | 搬迁 |
| `app/(main)/ops/agents/page.tsx` | 合并入 /team | 删除 |
| `app/(main)/ops/surfaces/page.tsx` | `app/(main)/system/page.tsx` | 搬迁 |
| `app/(main)/cron/page.tsx` | 删除 | cron 无独立路由 |
| `app/page.tsx` | 改 redirect | `/agents` → `/work` |

## 6. 页面设计与产品动线重构

不只是路由搬迁——以下每个页面都从用户意图出发重新设计，修正当前 UX 问题。

### 6.1 `/work` — Work Today（默认落地页）

**产品动线**：用户进门第一眼看到"有 N 件事等你拍板"，把"离场托付"的差异化卖点摆到 C 位。

**数据**：`GET /api/work/today` → `{ reviewQueue: LoopItem[], runs: RunSummary[], budgetAlerts: BudgetAlert[] }`

**布局**：
- 顶部：Review Queue — 所有 `awaiting_review` 的 loop item 跨 loop 聚合，按优先级排序
- 中部：今日运行概览（成功/失败/运行中计数 + 预算消耗条）
- 底部：异常告警（预算超限、连续失败、心跳过期）

**组件**：
- `WorkTodayPage` — 顶层布局
- `ReviewQueueCard` — 单个 awaiting_review item（loop 名 + summary + 证据摘要 + 快捷审批按钮）
- `RunSummaryList` — 今日运行列表
- `BudgetBar` — 各 loop 预算消耗

### 6.2 `/work/[loopId]` — Loop 详情（重构为 master-detail）

**产品动线**：用户要看"这件活的完整证据链"——Generator 产出了什么、Evaluator 怎么说的、为什么 PASS/REJECT。当前是扁平窄列表，证据不可读。

**重构**：从 `max-w-2xl` 扁平列表改为 **master-detail 双栏布局**：
- 左栏（窄）：item 列表，按 step 分组（fixing / verifying / awaiting_review / resolved），选中高亮
- 右栏（宽）：选中 item 的完整证据链
  - Generator 产出面板：diff 摘要 + 修改的文件列表 + run 链接
  - Evaluator 裁决面板：VERDICT.md 全文 + verdict（PASS/REJECT/ESCALATE）
  - 审批动作栏：approve / reject / promote / retry / dismiss + 反馈输入

**组件**：
- `LoopDetailPage` — master-detail 容器
- `ItemListView` — 左栏 item 列表
- `EvidenceChainPanel` — 右栏证据链
- `GeneratorOutputCard` — Generator 产出
- `EvaluatorVerdictCard` — Evaluator 裁决
- `ReviewActionBar` — 审批动作

### 6.3 `/work/[loopId]/runs/[runId]` — 单次运行详情

**产品动线**：用户从 Loop item 下钻到"这次运行到底干了什么"。这是可观测性下沉——不再有全局 ops 列表，执行事实贴着产生它的业务对象展示。

收编原 `ops/sessions/[id]` 的组件。数据源不变（`GET /api/ops/runs/:id`）。breadcrumb 从 `Observability > Sessions` 改为 `Work > {loopName} > Runs`。

**重构**：把原 `/ops` 页的 Cost Breakdown + Token Trend + Top Tools 图表**下沉到单次运行详情页**——"这次运行花了多少 token、用了什么工具"属于 run detail，不属于一级入口。

### 6.4 `/work/new` — Loop 配置对话向导（新）

**产品动线**：用户不暴露在 cron 语法和 skill 配置里，而是和 Agent 聊几轮就创建一个 Loop。

**是一个 AgentSession 多轮对话**：
1. 用户进入 `/work/new` → 前端创建 conversation + AgentSession，绑定 `loop-config-generator` skill pack（已存在于 `skills/loop-engine/loop-config-generator/`）
2. 用户自然语言描述意图（"每天早上 9 点检查 PR 并跑测试"）
3. AgentSession 多轮对话——Agent 通过 skill 提问澄清（cron 表达式、generator/evaluator model、acceptance、budget）
4. Agent 最终产出 LOOP.md 配置
5. 用户确认 → 调用现有 `POST /api/loops` 创建 cron_job + 写 LOOP.md

**不需要新增后端 API**——复用现有 conversation + AgentSession + skill pack 机制。

**组件**：
- `LoopWizardPage` — chat 画布 + 配置预览侧栏
- chat 画布复用 `/chat/[conversationId]` 的会话组件
- 配置预览侧栏实时解析 Agent 产出的 LOOP.md（可编辑）

### 6.5 `/chat` — 会话总览（新）

**产品动线**：不再"先选 Agent 再看会话"——会话是根，Agent 是成员。用户直接看到所有最近会话，点进去就能聊。

**数据**：`GET /api/conversations?recent=true` → 全局最近会话列表

**新建会话**：
- `/chat` 顶部输入框，用户直接输入消息
- 前端自动选默认 Agent（后端 seed 的 id=`default` Agent）
- 创建 conversation，跳转 `/chat/:conversationId`
- 会话内用户可 `@mention` 其他 Agent 加入

**组件**：
- `ChatOverviewPage` — 会话卡片列表 + 顶部输入框
- 会话卡片：标题 + 成员头像 + 最后消息时间 + 未读标记

### 6.6 `/chat/[conversationId]` — 会话画布（重构视觉层次）

**产品动线**：多 Agent 会话时用户分不清谁在说话。`@mention` 触发的 Agent 应有视觉区分。

原 `conversations/[id]/page.tsx` 搬入，但重构 `ConversationCanvas` 的视觉层次：
- 每个 Agent 有独立头像 + 颜色标识
- `@mention` 触发的 Agent 消息有"被叫到"标记（mention badge）
- Agent 正在运行时显示 typing indicator
- tool approval 卡片内联在消息流里（已有，保留）

### 6.7 `/team` — Agent 花名册（合并就绪状态）

**产品动线**：Agent 是"同事"——用户一眼看到所有同事的状态（在线/忙/空闲）。

原 `agents/page.tsx` 搬入。合并原 `/ops/agents` 的就绪状态（runtime status）——每个 Agent 卡片显示：头像 + 名字 + 模型 + 当前状态（idle/running/error）+ 最近活动时间。

### 6.8 `/team/[agentId]` — 单 Agent 详情（重构为"同事档案"）

**产品动线**：用户看一个同事——"他是谁、能干什么、最近在忙什么"，不是"先看线程列表"。

原 `agents/[id]/page.tsx` 搬入，但 tab 从 "Threads / Identity" 重构为 **"Persona / Skills / Activity"**：
- **Persona**：身份信息（name、model、systemPrompt、identity）— 合并原 Identity tab
- **Skills**：该 Agent 绑定的 Skill Packs — 从 Team skills 页下钻
- **Activity**：最近运行 + 最近会话 — 合并原 Threads tab + ops 运行数据

### 6.9 `/team/skills` — Skill Pack 分发

原 `skill-packs/page.tsx` 搬入。能力是团队资产，归在 Team 下。

### 6.10 `/team/projects` — Project 工作归属域

原 `projects/page.tsx` 搬入。Project 作为工作归属域，归在 Team 下。

### 6.11 `/system` — Surface 健康 + 全局 trace（低调）

**产品动线**：给运维用的系统健康页，不占一级心智。Ops 图表（Cost Breakdown / Token Trend / Top Tools）不下沉到这里的全局视图——它们属于单个 run 的详情。全局视图只保留 Surface 接入健康 + trace 检索。

**数据**：复用现有 `GET /api/ops/surfaces` + `GET /api/ops/runs`。

**组件**：
- `SystemPage` — 两个 tab：Surface 健康 + Trace 检索
- `SurfaceHealthTable` — 从原 `/ops/surfaces` 搬入
- `TraceSearchPanel` — 全局 run 检索（简化版，不含图表，只列表 + 跳转 run detail）

## 7. 后端变更

### 7.1 新增 API

| API | 用途 |
|-----|------|
| `GET /api/work/today` | 查所有 `loop_item` where `step = 'awaiting_review'` + 今日 run 摘要 + 预算告警 |
| `GET /api/conversations?recent=true` | 扩展现有 list，无 agentId 时返回全局最近会话 |

### 7.2 默认 Agent seed

`main.ts` 启动时检查 agent 表是否为空，为空则创建默认 Agent（id=`default`, name=`Assistant`）。不加 `isDefault` 字段。

### 7.3 不改动

Loop/Cron 领域模型、API 契约、session 机制、skill pack 机制。

## 8. NavRail 重写

4 个 SidebarGroup，完全替换现有结构：

```
Work
  ├── Today          → /work
  └── New Loop       → /work/new
Chat
  └── (全局最近会话列表内联)
Team
  ├── Agents         → /team
  ├── Skill Packs    → /team/skills
  └── Projects       → /team/projects
System
  └── System         → /system
```

- 删除原 Workspace/Navigate/Operations 三组
- 删除重复的 Loops 条目
- 删除 `userRef: "__legacy__"` 占位
- Chat 组会话列表改为全局最近会话（不依赖 selectedAgentId）

## 9. 前端 hooks/api 变更

| 项 | 改动 |
|----|------|
| `features/ops/hooks.ts` | 新增 `useWorkToday()` 调 `GET /api/work/today` |
| `features/conversations/hooks.ts` | 新增 `useRecentConversations()` 调 `GET /api/conversations?recent=true` |
| `lib/api.ts` | 新增 `getWorkToday()` + `listRecentConversations()` |
| 其他 hooks | 不变（API 路径不变，只是前端路由变） |

## 10. 硬编码路由引用清理

搬迁不是 `git mv`——57 个硬编码路由引用分布在 21 个文件里，全部要改。

### 路由映射表

| 旧路由 | 新路由 | 出现次数 | 涉及文件 |
|--------|--------|---------|---------|
| `/agents` `/agents/:id` | `/team` `/team/:agentId` | 8 | NavRail, AgentList, AgentForm, ConversationCanvas, login, page.tsx, auth route |
| `/conversations/:id` | `/chat/:conversationId` | 6 | NavRail, ConversationList, loops/[id], cron/page |
| `/loops` `/loops/:id` `/loops/new` | `/work` `/work/:loopId` `/work/new` | 9 | NavRail, loops/page, loops/[id], loops/new |
| `/ops` `/ops/sessions/*` `/ops/agents/*` `/ops/surfaces` | `/system` `/work/:loopId/runs/:runId` `/team` `/system` | 18 | NavRail, ops/* pages, HealthSummary, RunOpsTable, NeedsAttentionList |
| `/cron` | 删除 | 2 | NavRail |
| `/projects` `/skill-packs` | `/team/projects` `/team/skills` | 4 | NavRail |

### 语义错误修正（ADR 0011 指出）

| 位置 | 问题 | 修正 |
|------|------|------|
| `cron/page.tsx:57` | `Link href={/conversations/${job.cronJobId}}` — 把 cronJobId 当 conversationId | 改为跳 `/work/:loopId`（cron 已归入 work） |
| `loops/[id]/page.tsx:89` | `a href={/conversations/${loop.id}}` — 把 loop.id 当 conversationId | 改为跳会话详情时用正确的 conversationId，或跳 `/work/:loopId` |
| `ops/RunOpsTable.tsx:133` | `href={/ops/sessions/${r.sessionId}}` | 改为 `/work/:loopId/runs/:runId`（需查 run→loop 映射） |
| `ops/HealthSummary.tsx` | 5 个 `/ops/...` 链接 | 全部改为新路由 |

### ops 组件内部引用

`components/ops/` 下的组件（HealthSummary、RunOpsTable、NeedsAttentionList）内部有大量 `/ops/...` 跳转链接。这些组件搬到 `/system` 和 `/work/[loopId]/runs/` 后，内部链接全部要改。

## 11. 清理项

| 项 | 位置 | 动作 |
|----|------|------|
| 重复 Loops 条目 | NavRail.tsx:289-299 | NavRail 重写时消失 |
| `userRef: "__legacy__"` | NavRail.tsx:124 + conversation 创建 | 删除 |
| `/cron` 路由 | app/(main)/cron/ | 删除目录 |
| `/ops` 路由 | app/(main)/ops/ | 删除目录（组件搬迁后） |
| 语义错误跳转 | cron/page, loops/[id], ops 组件 | 见 §10 修正表 |

## 12. 验收标准

1. `/work` `/chat` `/team` `/system` 四个一级路由可访问，目录与 URL 一致
2. 根路由 `/` redirect 到 `/work`
3. `/work` 展示 awaiting_review item 队列 + 今日运行概览
4. `/work/new` 是 AgentSession 对话页面，绑定 `loop-config-generator` skill，多轮对话生成 LOOP.md
5. `/chat` 展示全局最近会话列表，不要求先选 Agent
6. `/chat` 新建会话时自动选默认 Agent
7. `/team` 展示 Agent 花名册含就绪状态，`/team/[agentId]` 含最近运行
8. `/system` 展示 Surface 健康 + 全局 trace
9. NavRail 4 组（Work/Chat/Team/System），无重复条目，无 `__legacy__`
10. 旧路由 `/agents` `/loops` `/conversations` `/cron` `/ops` `/skill-packs` `/projects` 不再存在（404）
11. 旧路由的所有硬编码引用已清零（grep `/agents` `/loops` `/conversations` `/cron` `/ops` `/skill-packs` `/projects` 在 `apps/web/src` 下无匹配）
12. `bun run typecheck && bun run test && bun run lint` 全绿

## 13. 关联

- [ADR 0011](../../adr/0011-web-ia-work-chat-team.md) — 决策记录
- [loop-config-generator skill](../../../skills/loop-engine/loop-config-generator/SKILL.md) — `/work/new` 使用的 skill
- [设计哲学](../../architecture/design-philosophy.md) — 暴露业务、隐藏机制；边界要硬、概念要少
