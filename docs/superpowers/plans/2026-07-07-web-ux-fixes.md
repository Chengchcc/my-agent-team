# 前端 UX 补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 修复 8 个 UX 问题——Work Today 补全、Draft Loop 可见、enable/disable 开关、Chat origin 过滤、Team 就绪状态、Skills/Projects 布局、首条消息传递、Generator 产出展示。

**Spec:** `docs/superpowers/specs/2026-07-07-web-ux-fixes-design.md`

---

## 代码事实（探查确认）

| 事实 | 位置 |
|------|------|
| ConversationRow 有 origin 字段 | `conversation/ports.ts:13` |
| Loop 创建时 origin="loop" | `loop/http.ts:169` |
| ItemState 无 spanId/runId 字段 | `loop/types.ts:21-29` |
| genSession.sessionId 存在但 dispose 后不可恢复 | `loop-step.ts:273-275` |
| Generator assistant 消息写入 conversation ledger（conversationId=loopId） | conversation run-accumulator |
| cronSvc.setEnabled(id, bool) 同步返回 CronJobRow | `cron/service.ts:149` |
| scheduler.register/unregister 已有 | `cron/scheduler.ts:270-290` |
| useAgentRuntimes hook 已存在 | `features/ops/hooks.ts` |

---

## Task 1: P1+P2 — Work Today 补全（今日运行 + Draft Loops）

**Files:**
- Modify: `apps/web/src/app/(main)/work/page.tsx`

- [ ] **Step 1: 在 Review Queue 下方加"今日运行概览"区块**

用 `useOpsRuns()` 取今日运行数据，展示成功/失败/运行中计数。

- [ ] **Step 2: 加"Draft Loops"区块**

用 `useLoopList()` 取所有 Loop，过滤 `enabled === false`，展示为卡片列表。点击跳 `/work/:loopId`。

- [ ] **Step 3: Commit**

---

## Task 2: P3 — Loop 详情页加 enable/disable 开关

**Files:**
- Modify: `apps/web/src/app/(main)/work/[loopId]/page.tsx`
- Modify: `apps/web/src/lib/api.ts`（加 setLoopEnabled）
- Modify: `apps/web/src/features/loop/hooks.ts`（加 useSetLoopEnabled）

- [ ] **Step 1: api.ts 加 setLoopEnabled**

先读 api.ts 确认 cron API 模式。`PUT /api/cron-jobs/:id/enabled` 或类似。

- [ ] **Step 2: hooks.ts 加 useSetLoopEnabled**

- [ ] **Step 3: work/[loopId]/page.tsx 加开关**

在 header "Run Now" 旁加 Switch 组件。Draft Loop 显示 "Draft" 徽标 + "Activate" 按钮。

- [ ] **Step 4: Commit**

---

## Task 3: P4 — NavRail Chat 组过滤 Loop/Cron 会话

**Files:**
- Modify: `apps/web/src/components/NavRail.tsx`

- [ ] **Step 1: 过滤 origin !== "loop" 的会话**

在 NavRail 的 conversations 列表渲染前加 filter。先确认 `api.listConversations()` 返回的数据是否带 `origin` 字段——读 api.ts 和后端 http.ts 确认。

- [ ] **Step 2: Commit**

---

## Task 4: P5 — Team 页加 Agent 就绪状态

**Files:**
- Modify: `apps/web/src/app/(main)/team/page.tsx` 或 `apps/web/src/components/AgentList.tsx`

- [ ] **Step 1: 用 useAgentRuntimes 获取运行状态**

读 `features/ops/hooks.ts` 确认 useAgentRuntimes 签名。在 team/page.tsx 或 AgentList 里调它。

- [ ] **Step 2: AgentList 卡片加状态指示器**

每个 Agent 卡片加：状态圆点（green=idle, blue=running, red=error）+ 最近活动时间。

- [ ] **Step 3: Commit**

---

## Task 5: P6 — Team Skills/Projects 页加布局

**Files:**
- Modify: `apps/web/src/app/(main)/team/skills/page.tsx`
- Modify: `apps/web/src/app/(main)/team/projects/page.tsx`

- [ ] **Step 1: skills/page.tsx 加 Breadcrumb + header**

```tsx
<div className="h-full bg-[var(--canvas)]">
  <div className="border-b border-[var(--hairline)]">
    <div className="container mx-auto px-8 py-5">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbPage>Skill Packs</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  </div>
  <div className="container mx-auto px-8 py-10">
    <SkillPackManager />
  </div>
</div>
```

- [ ] **Step 2: projects/page.tsx 确认布局一致**

- [ ] **Step 3: Commit**

---

## Task 6: P7 — Chat 新建会话传递首条消息

**Files:**
- Modify: `apps/web/src/app/(main)/chat/page.tsx`
- Modify: `apps/web/src/app/(main)/chat/[conversationId]/page.tsx`

- [ ] **Step 1: chat/page.tsx 创建会话时传 input 通过 URL query**

```typescript
onSuccess: (conv) => {
  router.push(`/chat/${conv.conversationId}?initial=${encodeURIComponent(input)}`);
}
```

- [ ] **Step 2: chat/[conversationId]/page.tsx 读取 initial query 并自动发送**

会话页面读取 `searchParams.get("initial")`，如果有值则在会话加载后自动发送。

注意：当前 `chat/[conversationId]/page.tsx` 是 Server Component（async function）。需要改为 Client Component 或在 ConversationCanvas 里处理 initial message。

- [ ] **Step 3: Commit**

---

## Task 7: P8 — Generator 产出展示

**Files:**
- Modify: `packages/loop/src/types.ts`（ItemState 加 generatorSpanId）
- Modify: `apps/backend/src/features/loop/loop-step.ts`（GENERATOR_DONE 时存 spanId）
- Modify: `apps/backend/src/features/loop/http.ts`（item map 加 generatorSpanId）
- Modify: `apps/web/src/components/work/EvidenceChainPanel.tsx`（展示 Generator 产出）

- [ ] **Step 1: ItemState 加 generatorSpanId 字段**

`types.ts`:
```typescript
export type ItemState = {
  id: ItemId;
  source: string;
  summary: string;
  step: ItemStep;
  attempt: number;
  priority: number;
  result: Verdict | null;
  generatorSpanId?: string;  // ← 新增
};
```

- [ ] **Step 2: loop-step.ts GENERATOR_DONE 时存 spanId**

在 `genSession.prompt()` 调用后、`GENERATOR_DONE` dispatch 前，把 `genSession` 的 spanId 存入 item。需要先读 loop-step.ts 确认 GENERATOR_DONE action 的 payload 和 reducer 逻辑——可能需要加一个新 action type 或扩展 GENERATOR_DONE 的 payload。

- [ ] **Step 3: http.ts item map 加 generatorSpanId**

- [ ] **Step 4: EvidenceChainPanel 展示 Generator 产出**

用 `generatorSpanId` 查 conversation ledger（`GET /api/conversations/:id` 的 ledger entries），展示 Agent 的最后一条 assistant 消息。

- [ ] **Step 5: Commit**

---

## Task 8: 最终验证

- [ ] **Step 1: typecheck + test + biome**
- [ ] **Step 2: Commit + push**
