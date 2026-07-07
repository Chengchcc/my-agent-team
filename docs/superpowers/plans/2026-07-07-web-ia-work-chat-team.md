# Web IA 重组 — Work / Chat / Team / System

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Web 信息架构从"模块地图"重组为"用户意图地图"（Work / Chat / Team / System），同时修正产品动线 UX 问题。

**Architecture:** Next.js App Router 目录搬迁 + 组件重构。后端新增 2 个读 API + 默认 Agent seed。多个 UX 问题是"已接线但未展示"——修复点是接通数据而非新建。

**Tech Stack:** Next.js 15 App Router, React Query v5, shadcn/ui, Tailwind CSS v4, Elysia (backend), Bun

**Spec:** `docs/superpowers/specs/2026-07-07-web-ia-work-chat-team-design.md`

---

## 代码事实（探查结论，下笔依据）

| 问题 | 结论 | 关键事实 |
|------|------|---------|
| Loop 详情证据链 | API 层截断 | `loop/http.ts:77-82` map 丢弃 result/attempt/priority；verdict 在 `LoopState.items[].result` 真实存在 |
| 多 Agent 视觉 | 已接线但未展示 | `SenderRef` 缺 agentId（后端 Member 有）；`MessageBubble` 只做 agent/human 二色 |
| Ops 图表 | 已接线但未展示 | per-run insights API (`GET /api/ops/runs/:id/insights`) 存在但三图没用它 |
| 全局会话列表 | 后端已支持 | `conversation/http.ts:10-15` 不带 agentId 走 `listConversations()` |
| cron/loop 同源 | 确认同表 | `cron_job` 表 + `loopConfigPath` 列区分 |
| Generator 产出 | 未持久化 | loop-step.ts GENERATOR_DONE 不存产出（瞬态 git diff），需读 run/conversation |

---

## 文件结构

### 新增文件

```
apps/web/src/
├── app/(main)/
│   ├── work/
│   │   ├── page.tsx                          # Work Today
│   │   ├── [loopId]/
│   │   │   ├── page.tsx                      # Loop 详情（master-detail）
│   │   │   └── runs/[runId]/page.tsx         # 单次运行详情
│   │   └── new/page.tsx                      # Loop 配置对话向导
│   ├── chat/
│   │   ├── page.tsx                          # 会话总览
│   │   └── [conversationId]/page.tsx         # 会话画布
│   ├── team/
│   │   ├── page.tsx                          # Agent 花名册
│   │   ├── [agentId]/page.tsx                # Agent 详情
│   │   ├── skills/page.tsx                   # Skill Packs
│   │   └── projects/page.tsx                 # Projects
│   └── system/page.tsx                       # Surface 健康 + trace
├── components/
│   ├── work/
│   │   ├── ReviewQueueCard.tsx               # awaiting_review item 卡片
│   │   ├── EvidenceChainPanel.tsx            # 证据链右栏
│   │   └── ReviewActionBar.tsx               # 审批动作栏
│   └── chat/
│       └── ChatOverviewPage.tsx              # 会话总览组件
```

### 删除文件

```
apps/web/src/app/(main)/cron/                 # cron 无独立路由
apps/web/src/app/(main)/ops/                  # 拆解到 work/system
apps/web/src/app/(main)/loops/                # 搬到 work/
apps/web/src/app/(main)/agents/               # 搬到 team/
apps/web/src/app/(main)/conversations/        # 搬到 chat/
apps/web/src/app/(main)/skill-packs/          # 搬到 team/skills/
apps/web/src/app/(main)/projects/             # 搬到 team/projects/
```

---

## Task 1: 后端 — Loop detail API 补全 verdict 字段

**Files:**
- Modify: `apps/backend/src/features/loop/http.ts:72-82`
- Test: `apps/backend/src/features/loop/http.test.ts`（如存在）

**问题**：`GET /api/loops/:id` 的 items map 丢弃了 `result`/`attempt`/`priority`，前端拿不到 Evaluator verdict。

- [ ] **Step 1: 修改 http.ts items map**

`apps/backend/src/features/loop/http.ts` 当前 map：
```typescript
items: Object.values(fullState.items).map((i) => ({
  id: i.id,
  source: i.source,
  summary: i.summary,
  step: i.step,
})),
```

改为：
```typescript
items: Object.values(fullState.items).map((i) => ({
  id: i.id,
  source: i.source,
  summary: i.summary,
  step: i.step,
  attempt: i.attempt,
  priority: i.priority,
  result: i.result ?? null,
})),
```

- [ ] **Step 2: 验证 typecheck**

```bash
cd apps/backend && npx tsc -p tsconfig.json --noEmit
```
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/loop/http.ts
git commit -m "fix(backend): expose verdict/attempt/priority in loop detail API"
```

---

## Task 2: 后端 — 新增 `GET /api/work/today`

**Files:**
- Modify: `apps/backend/src/features/loop/http.ts`（新增 route）
- Modify: `apps/backend/src/app.ts`（FeatureSet + wire）

**数据需求**：跨 loop 聚合 `awaiting_review` item + 今日 run 摘要 + 预算告警。

- [ ] **Step 1: 在 loop/http.ts 新增 GET /api/work/today route**

```typescript
.get("/api/work/today", async () => {
  const loops = cronSvc.list().filter((j) => j.loopConfigPath != null);
  const reviewQueue: unknown[] = [];
  for (const loop of loops) {
    const paths = resolveLoopPaths(loop, dataDir);
    try {
      const md = await Bun.file(`${paths.loopConfigPath}/STATE.md`).text();
      const state = parseStateMd(md);
      if (!state) continue;
      for (const item of Object.values(state.items)) {
        if (item.step === "awaiting_review") {
          reviewQueue.push({
            ...item,
            loopId: loop.cronJobId,
            loopName: loop.name,
          });
        }
      }
    } catch {
      continue;
    }
  }
  return { reviewQueue };
})
```

- [ ] **Step 2: 验证 typecheck + test**

```bash
cd apps/backend && npx tsc -p tsconfig.json --noEmit && bun test
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/loop/http.ts
git commit -m "feat(backend): add GET /api/work/today for Work Today page"
```

---

## Task 3: 后端 — 默认 Agent seed

**Files:**
- Modify: `apps/backend/src/main.ts`

- [ ] **Step 1: 在 main.ts agentSvc 初始化后加 seed 逻辑**

在 `const agentSvc = createAgentSvc(...)` 之后加：
```typescript
// Seed default agent if table is empty
if ((await agentSvc.list()).length === 0) {
  await agentSvc.create({
    id: "default",
    name: "Assistant",
    modelProvider: "anthropic",
    modelName: "claude-sonnet-4-20250514",
    permissionMode: "auto",
  });
  console.log("[backend] seeded default agent");
}
```

- [ ] **Step 2: 验证 typecheck**

```bash
cd apps/backend && npx tsc -p tsconfig.json --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/main.ts
git commit -m "feat(backend): seed default agent on first startup"
```

---

## Task 4: 前端 — 目录搬迁 + 硬编码路由清理

**Files:**
- Move: 7 个目录（见 spec §5 搬迁映射表）
- Modify: 21 个文件的 57 个硬编码路由引用（见 spec §10）
- Delete: `app/(main)/cron/`、`app/(main)/ops/`

这是最大的机械任务。按顺序执行：

- [ ] **Step 1: 创建新目录结构并搬迁文件**

```bash
cd apps/web/src/app/\(main\)
# work/
mkdir -p work/[loopId]/runs/[runId] work/new
cp loops/[id]/page.tsx work/[loopId]/page.tsx
cp ops/sessions/[sessionId]/page.tsx work/[loopId]/runs/[runId]/page.tsx
# chat/
mkdir -p chat/[conversationId]
cp conversations/[id]/page.tsx chat/[conversationId]/page.tsx
# team/
mkdir -p team/[agentId] team/skills team/projects
cp agents/page.tsx team/page.tsx
cp agents/[id]/page.tsx team/[agentId]/page.tsx
cp skill-packs/page.tsx team/skills/page.tsx
cp projects/page.tsx team/projects/page.tsx
# system/
mkdir -p system
cp ops/surfaces/page.tsx system/page.tsx
```

- [ ] **Step 2: 删除旧目录**

```bash
rm -rf loops conversations agents skill-packs projects cron ops
```

- [ ] **Step 3: 修改根路由 redirect**

`app/page.tsx`：
```typescript
import { redirect } from "next/navigation";
export default function Home() {
  redirect("/work");
}
```

- [ ] **Step 4: 修改 login redirect**

`app/(auth)/login/page.tsx:67` — `router.push("/agents")` → `router.push("/work")`
`app/api/auth/login/route.ts:21` — `new URL("/agents", req.url)` → `new URL("/work", req.url)`

- [ ] **Step 5: 批量替换硬编码路由**

用 eval 脚本批量替换 21 个文件中的 57 个引用：
- `/agents/${id}` → `/team/${id}`
- `/agents` → `/team`
- `/conversations/${convId}` → `/chat/${convId}`
- `/loops/${id}` → `/work/${id}`
- `/loops/new` → `/work/new`
- `/loops` → `/work`
- `/ops/sessions/${id}` → `/work/${loopId}/runs/${id}`（需 context 调整）
- `/ops/surfaces` → `/system`
- `/ops` → `/system`
- `/cron` → 删除相关条目
- `/skill-packs` → `/team/skills`
- `/projects` → `/team/projects`

- [ ] **Step 6: 验证无残留**

```bash
grep -rn "/agents\|/loops\|/conversations\|/cron\|/ops\|/skill-packs\|/projects" apps/web/src --include="*.tsx" --include="*.ts" | grep -v node_modules | grep -v ".next"
```
Expected: 0 matches

- [ ] **Step 7: 验证 typecheck**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(web): migrate route tree to work/chat/team/system"
```

---

## Task 5: 前端 — NavRail 重写

**Files:**
- Rewrite: `apps/web/src/components/NavRail.tsx`

- [ ] **Step 1: 重写 NavRail 为 4 组**

替换整个 `NavContent` 函数为 4 个 SidebarGroup：
- **Work**：Today → /work，New Loop → /work/new
- **Chat**：全局最近会话列表（调 `api.listConversations()` 无参）
- **Team**：Agents → /team，Skill Packs → /team/skills，Projects → /team/projects
- **System**：System → /system

删除 `userRef: "__legacy__"`。删除重复 Loops 条目。

- [ ] **Step 2: 验证 typecheck**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/NavRail.tsx
git commit -m "refactor(web): rewrite NavRail to Work/Chat/Team/System"
```

---

## Task 6: 前端 — `/work` Work Today 页

**Files:**
- Create: `apps/web/src/app/(main)/work/page.tsx`
- Create: `apps/web/src/components/work/ReviewQueueCard.tsx`
- Modify: `apps/web/src/lib/api.ts`（加 `getWorkToday()`）
- Modify: `apps/web/src/features/ops/hooks.ts`（加 `useWorkToday()`）

- [ ] **Step 1: api.ts 加 getWorkToday**

```typescript
getWorkToday: () => unwrap(client.api.work.today.get()),
```

- [ ] **Step 2: hooks.ts 加 useWorkToday**

```typescript
export function useWorkToday() {
  return useQuery({ queryKey: ["work-today"], queryFn: () => api.getWorkToday() });
}
```

- [ ] **Step 3: 创建 ReviewQueueCard 组件**

展示单个 awaiting_review item：loop 名 + summary + verdict 摘要 + 快捷审批按钮（approve/reject）。

- [ ] **Step 4: 创建 work/page.tsx**

布局：Review Queue 顶部 + 今日运行概览中部 + 异常告警底部。

- [ ] **Step 5: 验证 typecheck + lint**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/ --quiet
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): add Work Today page with review queue"
```

---

## Task 7: 前端 — `/work/[loopId]` master-detail 重构

**Files:**
- Rewrite: `apps/web/src/app/(main)/work/[loopId]/page.tsx`
- Create: `apps/web/src/components/work/EvidenceChainPanel.tsx`
- Create: `apps/web/src/components/work/ReviewActionBar.tsx`

**关键事实**：Task 1 已让 API 返回 `result`/`attempt`/`priority`，前端现在能拿到 verdict。

- [ ] **Step 1: 创建 EvidenceChainPanel**

右栏组件：展示选中 item 的 Generator 产出（从 run/conversation 读取）+ Evaluator verdict（`item.result`：PASS/REJECT/ESCALATE + evidence）+ ReviewActionBar。

- [ ] **Step 2: 创建 ReviewActionBar**

审批动作栏：approve / reject / promote / retry / dismiss + 反馈输入框。复用现有 `useReviewLoopItem` hook。

- [ ] **Step 3: 重写 work/[loopId]/page.tsx 为 master-detail**

左栏：item 列表按 step 分组（fixing / verifying / awaiting_review / resolved），选中高亮。
右栏：`<EvidenceChainPanel item={selectedItem} />`

- [ ] **Step 4: 验证 typecheck**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web):重构 Loop 详情为 master-detail 证据链布局"
```

---

## Task 8: 前端 — `/chat` 会话总览页

**Files:**
- Create: `apps/web/src/app/(main)/chat/page.tsx`
- Modify: `apps/web/src/features/conversations/hooks.ts`（加 `useRecentConversations`）

**关键事实**：后端已支持不带 agentId 的全局查询，前端直接调 `api.listConversations()` 即可。

- [ ] **Step 1: hooks.ts 加 useRecentConversations**

```typescript
export function useRecentConversations() {
  return useQuery({
    queryKey: conversationKeys.recent(),
    queryFn: () => api.listConversations(),
  });
}
```

- [ ] **Step 2: 创建 chat/page.tsx**

会话卡片列表 + 顶部输入框（新建会话，自动选默认 Agent）。

- [ ] **Step 3: 验证 typecheck**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(web): add Chat overview page with global conversation list"
```

---

## Task 9: 前端 — `/chat/[conversationId]` 多 Agent 视觉层次

**Files:**
- Modify: `apps/web/src/lib/conversation-reducer.ts`（SenderRef 补 agentId）
- Modify: `apps/web/src/components/MessageBubble.tsx`（per-agent 着色）

**关键事实**：后端 Member 有 agentId，前端 SenderRef 镜像没带。MessageBubble 只做 agent/human 二色。

- [ ] **Step 1: conversation-reducer.ts SenderRef 补 agentId**

```typescript
export interface SenderRef {
  memberId: string;
  kind: "agent" | "human";
  displayName?: string;
  agentId?: string;  // ← 新增
}
```

同步修改构建 SenderRef 的位置（从后端 Member 数据映射时带上 agentId）。

- [ ] **Step 2: MessageBubble per-agent 着色**

用 agentId 生成稳定颜色（hash → hue），替代当前 agent/human 二色。每个 Agent 有独立颜色标识。

- [ ] **Step 3: 验证 typecheck**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(web): add per-agent color coding in conversation canvas"
```

---

## Task 10: 前端 — `/team/[agentId]` tab 重构

**Files:**
- Rewrite: `apps/web/src/app/(main)/team/[agentId]/page.tsx`

**关键事实**：当前 tab 是 Threads（useConversationList）+ Identity（IdentityPanel）。重构为 Persona / Skills / Activity。

- [ ] **Step 1: 重写 tab 结构**

- **Persona**：复用 IdentityPanel
- **Skills**：展示该 Agent 绑定的 Skill Packs（复用 `useSkillPackListForAgent` 或类似 hook）
- **Activity**：最近运行（从 ops 数据取）+ 最近会话（复用 ConversationList）

- [ ] **Step 2: 验证 typecheck**

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(web): restructure agent detail tabs to Persona/Skills/Activity"
```

---

## Task 11: 前端 — `/work/[loopId]/runs/[runId]` Ops 图表下沉

**Files:**
- Modify: `apps/web/src/app/(main)/work/[loopId]/runs/[runId]/page.tsx`

**关键事实**：per-run insights API (`GET /api/ops/runs/:id/insights`) 已存在，前端 `useOpsRunInsights(id)` 已有但图表没用它。

- [ ] **Step 1: 在 run detail 页加 CostBreakdownChart / TokenTrendChart / TopToolsChart**

改图表组件的数据源从 `useOpsInsightsSummary(range)` 切到 `useOpsRunInsights(runId)`。注意 RunInsights 缺 tokenSeries/costByModel——需要适配或补 API。

- [ ] **Step 2: 验证 typecheck**

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(web): sink ops charts into run detail page"
```

---

## Task 12: 前端 — `/system` 页

**Files:**
- Create/Modify: `apps/web/src/app/(main)/system/page.tsx`

- [ ] **Step 1: 合并 Surface 健康 + trace 检索**

从原 `ops/surfaces/page.tsx` 搬入 SurfaceHealthTable，从原 `ops/page.tsx` 搬入 run 列表（简化版，不含图表）。两个 tab。

- [ ] **Step 2: 验证 typecheck**

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(web): add System page with surface health and trace search"
```

---

## Task 13: 前端 — `/work/new` Loop 配置对话向导

**Files:**
- Create: `apps/web/src/app/(main)/work/new/page.tsx`

**关键事实**：`skills/loop-engine/loop-config-generator/` skill 已存在。复用 conversation + AgentSession + skill pack 机制。

- [ ] **Step 1: 创建 /work/new 页面**

页面 = chat 画布（复用 ConversationCanvas）+ 配置预览侧栏。创建会话时绑定 `loop-config-generator` skill pack。用户多轮对话后 Agent 产出 LOOP.md，预览侧栏实时解析。确认后调 `POST /api/loops` 创建。

- [ ] **Step 2: 验证 typecheck**

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(web): add /work/new Loop config wizard with AgentSession"
```

---

## Task 14: 最终验证 + 清理

- [ ] **Step 1: 全量 typecheck**

```bash
bun run typecheck
```
Expected: 35/35 pass

- [ ] **Step 2: 全量 test**

```bash
bun run test
```
Expected: 35/35 pass

- [ ] **Step 3: 全量 lint**

```bash
bun run lint
```
Expected: 0 errors

- [ ] **Step 4: 硬编码路由 grep 验证**

```bash
grep -rn "/agents\|/loops\|/conversations\|/cron\|/ops\|/skill-packs\|/projects" apps/web/src --include="*.tsx" --include="*.ts" | grep -v node_modules | grep -v ".next"
```
Expected: 0 matches

- [ ] **Step 5: Commit + push**

```bash
git add -A
git commit -m "chore: final verification for Web IA restructure"
git push
```

---

## 回滚

改动局限在前端路由 + 组件 + 2 个后端读 API + 默认 Agent seed。无 schema migration、无运行时协议变更。回滚 = `git revert` 对应 commit。
