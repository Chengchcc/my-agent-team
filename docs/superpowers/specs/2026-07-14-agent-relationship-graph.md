# Spec: Agent Relationship Graph + Wake Routing

## Problem

Agent 之间扁平，靠用户手动 @mention 路由。没有 coordinator 概念，无法自动决定"无 @mention 时谁该响应"。

## Goal

引入 agent 关系图（assigns_to / collaborates_with），自动生成 RELATIONSHIPS.md 到 agent workspace，实现 wake routing（有 @mention 只唤醒被提及的；无 @mention 自动选 coordinator）。

## Design

### 数据模型

```
agent_relationship 表:
  id          TEXT PRIMARY KEY
  from_agent  TEXT NOT NULL REFERENCES agents(id)
  to_agent    TEXT NOT NULL REFERENCES agents(id)
  rel_type    TEXT NOT NULL  -- 'assigns_to' | 'collaborates_with'
  weight      REAL DEFAULT 1.0
  instruction TEXT           -- "Delegate when: ..." 协作指令
  created_at  INTEGER NOT NULL
  updated_at  INTEGER NOT NULL
  UNIQUE(from_agent, to_agent, rel_type)
```

Ponytail: 不建独立 feature 模块，挂在 agent feature 下（类似 mcp-servers 子路由）。

### API

```
GET    /api/agents/:id/relationships       -- 列出该 agent 的所有关系
POST   /api/agents/:id/relationships       -- 创建关系 { toAgentId, relType, weight?, instruction? }
PUT    /api/agents/:id/relationships/:rid  -- 更新 { weight?, instruction? }
DELETE /api/agents/:id/relationships/:rid  -- 删除
```

### RELATIONSHIPS.md 自动生成

关系变更时，为涉及的 agent 生成 `RELATIONSHIPS.md` 写入 `{workspaceRoot}/{agentId}/workspace/RELATIONSHIPS.md`：

```markdown
# Relationships for @AgentName

Auto-generated. Read this before deciding whether to coordinate, delegate, or collaborate.

## You coordinate
- @OtherAgent - description
  - Delegate when: instruction

## Coordinators for you
- @OtherAgent - description

## Collaborators
- @OtherAgent (weight 1.0) - description
  - Collaborate when: instruction
```

通过 identity plugin 的 beforeModel 注入（agent 已有 SOUL.md/USER.md 注入机制，RELATIONSHIPS.md 同路径）。

### Wake Routing

改造 `conversation-compose.ts` 的 `resolveTriggerTargets`：

```typescript
// 三级路由:
// 1. 有 addressedTo (@mention) -> 只唤醒被提及的 active agent
// 2. 有 @mention 模式但没匹配到 -> 返回空 (抑制所有响应)
// 3. 无 @mention (triggerMode=auto) -> selectCoordinatorID

function selectCoordinatorID(activeAgentIds: string[], edges: RelationshipEdge[]): string[] {
  if (activeAgentIds.length <= 1) return activeAgentIds;
  const hasParent = new Set<string>();
  for (const edge of edges) {
    if (activeAgentIds.includes(edge.from) && activeAgentIds.includes(edge.to)) {
      hasParent.add(edge.to);
    }
  }
  for (const id of activeAgentIds) {
    if (!hasParent.has(id)) return [id];  // 根节点 = coordinator
  }
  return [activeAgentIds[0]!];  // fallback
}
```

### 前端

Agent 详情页加 "Relationships" tab：
- 列出 assigns_to / collaborates_with 两组关系
- 每组有添加/删除按钮
- 关系图用简单列表渲染（不引入 ReactFlow）

### 不做

- 不做 ReactFlow 可视化图（130KB 依赖，文本列表足够）
- 不做 WebSocket 实时同步关系变更
- 不做 weight 动态调整 UI（API 支持但前端先不加）

## Files Touched

- `apps/backend/src/infra/db/schema.ts` -- agent_relationship 表
- `apps/backend/src/infra/db/migrations/0010_*.sql` -- migration
- `apps/backend/src/features/agent/relationship-service.ts` -- CRUD + RELATIONSHIPS.md 生成
- `apps/backend/src/features/agent/http.ts` -- relationships 子路由
- `apps/backend/src/features/conversation/conversation-compose.ts` -- wake routing
- `apps/web/src/app/(main)/team/[agentId]/page.tsx` -- Relationships tab
- `apps/web/src/components/RelationshipPanel.tsx` -- 关系列表 + 添加/删除
- `apps/web/src/features/agents/hooks.ts` -- useAgentRelationships hooks
