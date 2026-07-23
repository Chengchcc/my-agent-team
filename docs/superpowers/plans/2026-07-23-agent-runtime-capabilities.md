# Agent Runtime Capability Migration Implementation Plan

> **For agentic workers:** 本计划在 Runtime Foundation 和 Backend Adoption 完成后执行。先建立 Capability registry，再按行为类型迁移 plugin。不要在此计划内删除 framework/harness，不做最终命名清理。
>
> **Goal:** 把 backend 的 Agent 功能装配从 `conversation-compose.ts` 的手工 plugin 数组收敛为 Capability factory，同时保持 plugin 行为、模型配置、settings key、事件 payload 和 Conversation projection 兼容。
>
> **Architecture:** Capability 是 backend/application 层的安装单元；AgentHooks/Tools 是 Agent runtime 扩展；Services 由 backend closure 注入。Capability 不直接写 ledger、不依赖 React、不进入 `packages/agent`。
>
> **Contract:** [`2026-07-23-agent-runtime-contract.md`](../specs/2026-07-23-agent-runtime-contract.md)
>
> **Prerequisites:**
>
> - Runtime Foundation complete.
> - Backend Adoption complete.
> - AgentHooks tests pass.
> - Existing plugin tests pass.
>
> ---

## 0. Capability boundary

### Types

Implement backend-local types:

```ts
interface Capability {
  readonly id: string;
  extendAgent?(scope: AgentScope): AgentExtension | Promise<AgentExtension>;
  installServer?(ctx: CapabilityServerContext): void | Promise<void>;
  readonly manifest?: CapabilityManifest;
}

interface AgentExtension {
  hooks?: AgentHooks;
  tools?: readonly Tool[];
  systemPrompt?: string;
}

interface CapabilityManifest {
  id: string;
  slots?: readonly string[];
}
```

Services remain backend-owned:

```ts
interface Services {
  modelRegistry: ModelRegistry;
  settings: SettingsService;
  sse: SseBus;
  fs: AgentFs;
  conversation?: ConversationPort;
}
```

`AgentScope`, `CapabilityServerContext`, `SseBus`, and `AgentFs` are boundary names, not permission to invent broad infrastructure abstractions. Before implementation, map them to existing backend ports/services; introduce a new narrow port only when an existing service cannot express the required dependency. The capability task must record that mapping in its completion report.

### Forbidden dependencies

Capability/runtime code must not import:

```text
React / react-dom
apps/web
Elysia route internals from packages/agent
Conversation ledger adapter directly from capability implementation
```

Capability wrappers may receive ConversationPort through Services, but must not write ledger directly. They emit Agent events or return Agent hooks; projection remains Conversation-owned.

## 1. Capability registry

### Files

- Create: `apps/backend/src/capabilities/types.ts`
- Create: `apps/backend/src/capabilities/services.ts`
- Create: `apps/backend/src/capabilities/registry.ts`
- Create: `apps/backend/src/capabilities/agent-factory.ts`
- Create: `apps/backend/src/capabilities/index.ts`
- Test: `apps/backend/src/capabilities/*.test.ts`

### Required behavior

- Empty registry is valid.
- Duplicate capability IDs are rejected.
- Install order is deterministic.
- Tool name collisions are rejected.
- Hook contributions are aggregated in install order.
- Agent scope is isolated per Agent instance.
- Manifest slots are strings only; no React component type.
- Static import only.

### Non-goals

- No jiti/dynamic loader.
- No frontend dynamic slot rendering.
- No weak `Record<string, Handler>` route registry.
- No automatic discovery.
- No deletion of old plugin assembly.

### Acceptance

```bash
bun test apps/backend/src/capabilities
bun run --cwd apps/backend typecheck
```

Structural check:

```bash
! grep -R 'react\|React' apps/backend/src/capabilities
```

## 2. Context capabilities: identity / skill / conversation-context

### Files

- Create: `apps/backend/src/capabilities/identity.ts`
- Create: `apps/backend/src/capabilities/progressive-skill.ts`
- Create: `apps/backend/src/capabilities/conversation-context.ts`
- Modify only their implementation requires: corresponding `packages/plugin-*`
- Tests beside each capability and existing plugin tests

### Required behavior

#### Identity

- Preserve identity/bootstrap prompt.
- Preserve system prompt order.
- Preserve agent/workspace scope.

#### Progressive skill

- Preserve skill root resolution.
- Preserve skill index context key.
- Preserve skill tool behavior and cache.
- Do not persist temporary skill index as ordinary conversation history.

#### Conversation context

- Context is per-run, not per-session.
- Second message must not see first message input.
- Cron/Loop without conversation context must pass through normally.
- Preserve conversation tools and escaping rules.

### Acceptance

```bash
bun test packages/plugin-identity
bun test packages/plugin-progressive-skill
bun test packages/plugin-conversation-context
bun test apps/backend/src/features/conversation
bun run --cwd apps/backend typecheck
```

## 3. Control-flow capabilities: todo / goal

### Files

- Create: `apps/backend/src/capabilities/todo.ts`
- Create: `apps/backend/src/capabilities/goal.ts`
- Existing: `packages/plugin-todo/**`
- Existing: `packages/plugin-goal/**`
- Tests beside capabilities and plugins

### Required behavior

- `beforeStop` semantics unchanged.
- `maxForceContinues` remains authoritative.
- todo_update event contains correct run association.
- Goal evaluation count/history remains unchanged.
- Paused goal state remains unchanged.
- Tool error and unresolved work checks remain unchanged.

### Acceptance

```bash
bun test packages/plugin-todo
bun test packages/plugin-goal
bun test apps/backend/src/features/conversation
bun run --cwd apps/backend typecheck
```

## 4. Side-effect capabilities: pet / recap

### Files

- Create: `apps/backend/src/capabilities/pet.ts`
- Create: `apps/backend/src/capabilities/recap.ts`
- Existing: `packages/plugin-pet/**`
- Existing: `packages/plugin-recap/**`
- Tests beside capabilities and plugins

### Required behavior

- Model provider/name settings remain unchanged.
- Pet settings namespace remains unchanged.
- Pet and recap events retain payload shape.
- Event projection remains Conversation-owned.
- Capability does not append ledger entries directly.
- Best-effort behavior and error logging remain compatible.

### Acceptance

```bash
bun test packages/plugin-pet
bun test packages/plugin-recap
bun test apps/backend/src/features/conversation
bun run --cwd apps/backend typecheck
```

## 5. Memory capability

### Files

- Create: `apps/backend/src/capabilities/memory.ts`
- Existing: `packages/plugin-memory/**`
- Tests beside capability and plugin

### Required behavior

- `autoExtract` setting remains compatible.
- extract and consolidate model selection remains compatible.
- thresholds remain compatible.
- memory file layout remains unchanged.
- cache behavior remains unchanged.
- Memory context is per-run injection, not a new Message domain type.
- Memory failures do not corrupt Conversation ledger.

### Acceptance

```bash
bun test packages/plugin-memory
bun test apps/backend/src/features/conversation
bun run --cwd apps/backend typecheck
```

## 6. Replace conversation plugin assembly

### Files

- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`
- Modify only as needed: `apps/backend/src/features/span/agent-helpers.ts`
- Test: `apps/backend/src/features/conversation/*.test.ts`

### Required change

Replace direct assembly such as:

```text
petPlugin(...)
recapPlugin(...)
memoryPlugin(...)
goalPlugin(...)
```

with Capability-derived AgentExtensions. Keep the resulting hook/tool ordering explicit and tested.

### Non-goals

- Do not split `conversation-compose.ts` yet; that belongs to Cleanup.
- Do not change ledger schema.
- Do not change public HTTP/SSE contract.
- Do not remove old plugin package until cleanup.

### Acceptance

```bash
bun test apps/backend/src/features/conversation
bun run --cwd apps/backend typecheck
```

Structural check:

```bash
! grep -n 'petPlugin\|recapPlugin\|memoryPlugin\|goalPlugin' \
  apps/backend/src/features/conversation/conversation-compose.ts
```

## 7. Capability workstream gate

```bash
bun run --cwd apps/backend typecheck
bun test apps/backend/src/capabilities
bun test apps/backend/src/features/conversation
bun test packages/plugin-identity
bun test packages/plugin-progressive-skill
bun test packages/plugin-conversation-context
bun test packages/plugin-todo
bun test packages/plugin-goal
bun test packages/plugin-pet
bun test packages/plugin-recap
bun test packages/plugin-memory
```

Required smoke checks:

```text
identity prompt unchanged
skill injection unchanged
conversation context does not leak across turns
todo/goal stop behavior unchanged
pet/recap events project once
memory extraction/consolidation still run
```

## 8. Rollback

Rollback one capability group at a time by restoring the old plugin assembly. Do not run old and new capability implementations together for the same Agent; that would duplicate model calls and side effects.
