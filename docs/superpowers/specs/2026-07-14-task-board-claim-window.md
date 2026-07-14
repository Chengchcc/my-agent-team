# Spec: Task Board + Claim Window

## Problem

Loop 的 `ItemState` 已有 priority/step/awaiting_review 数据模型，但没有 UI 看板层。用户只能在 Loop 详情页的列表里看到 items，无法像 kanban 一样按状态分组浏览、拖拽流转。也没有 claim 窗口机制（@mention 的 agent 优先认领）。

## Goal

1. 为 Loop items 加 kanban 看板 UI（5 列：fixing -> verifying -> awaiting_review -> resolved + inbox）
2. 引入 claim window 机制（纯内存，30s 窗口，@mention 优先认领）
3. Task action buttons（approve/reject/promote/retry/dismiss）

## Design

### 看板 UI

复用现有 Loop `ItemState` 数据，不新增表。看板是 Loop 详情页的可选视图模式（toggle：list / board）。

```
┌─────────────┬──────────────┬──────────────────┬──────────┬───────┐
│ FIXING (2)  │ VERIFYING(1) │ AWAITING_REVIEW  │ RESOLVED │ INBOX │
├─────────────┼──────────────┼──────────────────┼──────────┼───────┤
│ #1 fix auth │ #3 lint pass │ #2 review needed │ #4 done  │       │
│ priority:high│ priority:normal│ priority:urgent│         │       │
│ attempt:2   │ attempt:1    │ attempt:1        │          │       │
└─────────────┴──────────────┴──────────────────┴──────────┴───────┘
```

每列对应 `ItemStep`：
- `fixing` -> FIXING
- `verifying` -> VERIFYING  
- `awaiting_review` -> AWAITING_REVIEW
- `resolved` -> RESOLVED
- `inbox` -> INBOX

卡片字段：`#itemId`、`summary`（truncate 2 行）、`priority` badge、`attempt` count、`source` icon。

点击卡片 -> 右侧 EvidenceChainPanel（已有）。

### Task Action Buttons

`awaiting_review` 列的卡片底部显示操作按钮（复用现有 `ReviewActionBar`）：
- Approve -> `POST /api/loops/:id/review` { action: "approve", itemId }
- Reject -> `POST /api/loops/:id/review` { action: "reject", itemId, feedback }
- Promote -> `POST /api/loops/:id/review` { action: "promote", itemId }
- Retry -> `POST /api/loops/:id/review` { action: "retry", itemId }
- Dismiss -> `POST /api/loops/:id/review` { action: "dismiss", itemId }

### Claim Window（Phase 2，先不实现）

纯内存，30s 窗口。当 Loop item 通过手动添加或 @mention 触发时：
1. `OpenWindow(itemId, mentionedAgentIds)` -> 30s 内只有 mentioned agent 可以 claim
2. 超时后 `ScheduleExpiry` 回调 -> 放给其他 agent
3. Claim 成功后 `CloseWindow` 立即关闭

Ponytail: 当前 Loop 的 Generator/Evaluator 是自动分配的，不需要 claim。Claim window 留到引入多 agent 协作 task 时再实现。spec 记录设计，代码不写。

### 视图切换

Loop 详情页顶部加 toggle：`[List] [Board]`
- List: 现有的按 step 分组列表（默认）
- Board: kanban 看板

状态保存在 URL searchParams（`?view=board`），可分享。

### 不做

- 不做拖拽改状态（Loop item 的状态由 generator/evaluator 流转，不是人拖拽改的）
- 不做 claim window 代码（Phase 2）
- 不做 subtask 嵌套（Loop item 没有 parent-child）
- 不做 per-channel task numbering（Loop item 用 ulid）

## Files Touched

- `apps/web/src/app/(main)/work/[loopId]/page.tsx` -- 加视图 toggle + Board 布局
- `apps/web/src/components/work/LoopBoard.tsx` -- kanban 看板组件
- `apps/web/src/components/work/LoopCard.tsx` -- 单个 item 卡片
- 复用现有 `ReviewActionBar` + `EvidenceChainPanel`
