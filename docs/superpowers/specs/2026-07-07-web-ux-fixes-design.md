# Spec: 前端 UX 补全 — 8 个产品动线问题修复

> 状态：待评审
> 关联：ADR 0011（Web IA Work/Chat/Team）、Loop 创建向导 spec
> 设计约束：`docs/architecture/design-philosophy.md` —— 暴露业务、隐藏机制

## 1. 问题清单与修复方案

### P1: Work Today 页补全"今日运行"和"异常告警"

**现状**：`/work` 只有 Review Queue 一个区块。
**修复**：
- 中部加"今日运行概览"：成功/失败/运行中计数 + 总 token 消耗（从 `GET /api/ops/runs` 取今日数据）
- 底部加"Draft Loops"区块：列出 `enabled:false` 的 Loop，让用户能回到未完成的创建流（点击跳 `/work/:loopId`）

### P2: Draft Loop 可见性

**现状**：Draft Loop 出现在 `GET /api/loops` 列表里，但 `/work` 不展示 Loop 列表。
**修复**：P1 的 "Draft Loops" 区块解决。同时在 Loop 详情页加 Draft 状态标识。

### P3: Loop 详情页加 enable/disable 开关

**现状**：`/work/[loopId]` 有 "Run Now" 但没有 enable/disable。
**修复**：
- 在 header 的 "Run Now" 按钮旁加一个 Switch 组件（enable/disable）
- Draft Loop（`enabled:false`）显示 "Draft" 徽标 + "Activate" 按钮
- 已启用 Loop 显示 Switch=on，可关闭
- 调用 `cronSvc.setEnabled(id, bool)` + `scheduler.register/unregister`

### P4: NavRail Chat 组区分会话来源

**现状**：所有会话混在一起。
**修复**：NavRail Chat 组只展示 `origin !== "loop"` 且 `origin !== "cron"` 的会话（即人机对话）。Loop/Cron 会话的运行产出在 `/work` 侧查看，不在 Chat 侧。
- 需要确认 `GET /api/conversations` 返回的 `origin` 字段是否已可用（conversation/ports.ts 里 ConversationRow 有 `origin` 字段）

### P5: Team 页加 Agent 就绪状态

**现状**：`/team` 只是 `<AgentList />`，无 runtime status。
**修复**：
- 用 `useAgentRuntimes(agentIds)` 获取每个 Agent 的运行状态
- AgentList 卡片加状态指示器（idle/running/error）+ 最近活动时间
- 从原 `/ops/agents` 页搬移 runtime status 展示逻辑

### P6: Team Skills/Projects 页加布局

**现状**：`/team/skills` 是裸 `<SkillPackManager />`，无 breadcrumb/header。
**修复**：
- 加 Breadcrumb（Team > Skills）+ header
- `/team/projects` 确保布局一致（已有 breadcrumb，检查是否需要调整）

### P7: Chat 总览页新建会话传递第一条消息

**现状**：创建会话后跳转，但用户输入文本丢失。
**修复**：
- 创建会话时，在 `onSuccess` 里把输入文本通过 URL query param 传递（`/chat/:id?initial=用户输入`）
- 或用 React state / sessionStorage 传递
- 会话页面读取后自动发送

### P8: Generator 产出展示

**现状**：Generator 产出从未持久化（loop-step.ts 不存），EvidenceChainPanel 显示空。
**修复**：
- Generator 运行后，从该 run 的 conversation ledger 读取 Agent 的 assistant 消息作为产出展示
- `GET /api/loops/:id` 的 item 数据加 `generatorRunId` 字段（如果已有 spanId 可用）
- EvidenceChainPanel 用 `generatorRunId` 查 conversation ledger，展示 Agent 的最后一条 assistant 消息摘要

## 2. 验收标准

1. `/work` 页有 Review Queue + 今日运行概览 + Draft Loops 三个区块
2. Draft Loop 在 `/work` 可见，点击跳详情页
3. Loop 详情页有 enable/disable 开关
4. NavRail Chat 组不展示 Loop/Cron 会话
5. `/team` 页每个 Agent 有就绪状态指示器
6. `/team/skills` 和 `/team/projects` 有完整布局（breadcrumb + header）
7. `/chat` 新建会话后第一条消息自动发出
8. EvidenceChainPanel 展示 Generator 产出（从 conversation ledger 读）
9. typecheck + test + lint 全绿
