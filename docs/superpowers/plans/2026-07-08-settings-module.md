# Settings 模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 后端通用 KV settings store + 前端按领域分 section 的配置管理页面。

**Architecture:** 新增 `features/settings/` feature（KV store + API），各 feature 消费处改为 `settings.get() ?? default`。前端 `/system/settings` 滚动表单。

**Spec:** `docs/superpowers/specs/2026-07-08-settings-module-design.md`

---

## 代码事实

| 事实 | 位置 |
|------|------|
| `maxConsecutiveAgentHops: 8` 硬编码 | `conversation-compose.ts:150` |
| `toolResultTruncator({maxCharsPerResult: 50_000})` 硬编码 | `agent-helpers.ts:90` |
| `autoSummarize({triggerAt: 100_000, keepRecent: 10})` 硬编码 | `agent-helpers.ts:91` |
| `maxSteps: 50` 默认值 | `harness/agent-session.ts:107` |
| `retry: {maxAttempts: 3, backoffMs: 2000, maxBackoffMs: 30000}` 默认值 | `harness/agent-session.ts:108-109` |
| `compaction: {autoCompact: true, keepRecent: 10}` 默认值 | `harness/agent-session.ts:110-111` |
| 心跳/reaper 从 config（env）读 | `config.ts` + `supervisor.ts` |
| Loop 空模板默认值 | `loop/http.ts:233-248` |
| envSchema 20 个环境变量 | `packages/config/src/env.ts:13-50` |
| BackendConfig 派生路径 | `config.ts:5-23` |

---

## Task 1: 后端 - settings feature 骨架

**Files:**
- Create: `apps/backend/src/features/settings/domain.ts`
- Create: `apps/backend/src/features/settings/ports.ts`
- Create: `apps/backend/src/features/settings/adapter-sqlite.ts`
- Create: `apps/backend/src/features/settings/service.ts`
- Create: `apps/backend/src/features/settings/http.ts`
- Create: `apps/backend/src/features/settings/index.ts`
- Modify: `apps/backend/src/infra/db/schema.ts`（加 settings 表）
- Modify: `apps/backend/src/app.ts`（FeatureSet 加 settings）
- Modify: `apps/backend/src/main.ts`（创建 settingsService + wire）

- [ ] **Step 1: schema.ts 加 settings 表**

```typescript
export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer({ mode: "number" }).notNull(),
});
```

- [ ] **Step 2: domain.ts**

```typescript
export interface SettingsRow {
  key: string;
  value: string;  // JSON string
  updatedAt: number;
}
```

- [ ] **Step 3: ports.ts**

```typescript
export interface SettingsPort {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  getAll(): SettingsRow[];
}
```

- [ ] **Step 4: adapter-sqlite.ts**

SQLite 实现，drizzle CRUD。

- [ ] **Step 5: service.ts**

```typescript
export function createSettingsService(deps: { port: SettingsPort; config: BackendConfig }) {
  return {
    get<T>(key: string): T | undefined {
      const raw = deps.port.get(key);
      if (raw === undefined) return undefined;
      try { return JSON.parse(raw) as T; } catch { return undefined; }
    },
    set<T>(key: string, value: T): void {
      deps.port.set(key, JSON.stringify(value));
    },
    getAll(): Record<string, unknown> {
      const rows = deps.port.getAll();
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        try { result[row.key] = JSON.parse(row.value); } catch {}
      }
      return result;
    },
    getSystemInfo() {
      const env = process.env;
      const maskKey = (k: string, v: string) =>
        k.includes("KEY") || k.includes("TOKEN") || k.includes("SECRET") || k.includes("PASSWORD")
          ? `****${v.slice(-4)}`
          : v;
      return {
        env: {
          BACKEND_HOST: env.BACKEND_HOST ?? "0.0.0.0",
          BACKEND_PORT: env.BACKEND_PORT ?? "3000",
          BACKEND_DATA_DIR: env.BACKEND_DATA_DIR ?? "",
          ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ? maskKey("KEY", env.ANTHROPIC_API_KEY) : "",
          ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? "",
          NODE_ENV: env.NODE_ENV ?? "development",
        },
        paths: {
          dataDir: deps.config.dataDir,
          workspaceRoot: deps.config.workspaceRoot,
          agentWorkspace: `${deps.config.dataDir}/agents/:id`,
          skillPacks: `${deps.config.dataDir}/skill-packs`,
          checkpointerDb: `${deps.config.dataDir}/checkpointer.db`,
          backendDb: `${deps.config.dataDir}/backend.db`,
          builtinSkills: deps.config.builtinSkillsDir,
        },
      };
    },
  };
}
export type SettingsService = ReturnType<typeof createSettingsService>;
```

- [ ] **Step 6: http.ts**

```typescript
export function settingsRoutes(svc: SettingsService) {
  return new Elysia()
    .get("/api/settings", () => ({ settings: svc.getAll() }))
    .get("/api/settings/system", () => svc.getSystemInfo())
    .put("/api/settings/:key", ({ params: { key }, body }) => {
      svc.set(key, body.value);
      return { ok: true, key, value: body.value };
    }, {
      body: t.Object({ value: t.Unknown() }),
    });
}
```

- [ ] **Step 7: index.ts barrel + main.ts wire + app.ts FeatureSet**

- [ ] **Step 8: Commit**

---

## Task 2: 后端 - 各 feature 消费 settings

**Files:**
- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`
- Modify: `apps/backend/src/features/span/agent-helpers.ts`
- Modify: `apps/backend/src/features/loop/http.ts`

- [ ] **Step 1: conversation-compose.ts 读 maxHops**

`maxConsecutiveAgentHops: 8` 改为 `settings.get<number>('conversation.maxHops') ?? 8`。需要把 settingsService 注入 createConversationFeature。

- [ ] **Step 2: agent-helpers.ts 读 context manager 参数**

`defaultContextManager` 改为接受 settings 参数：
```typescript
export function defaultContextManager(settings?: SettingsService): ContextManager {
  return pipeContextManagers(
    toolResultTruncator({ maxCharsPerResult: settings?.get<number>('context.toolResultMaxChars') ?? 50_000 }),
    autoSummarize({
      triggerAt: settings?.get<number>('context.summarizeTriggerAt') ?? 100_000,
      keepRecent: settings?.get<number>('context.summarizeKeepRecent') ?? 10,
    }),
  );
}
```

- [ ] **Step 3: loop/http.ts 空 Loop 模板用 settings 默认值**

空模板的 generatorModel/evaluatorModel/acceptance/dailyCap/denylist 从 settings 读。

- [ ] **Step 4: Commit**

---

## Task 3: 前端 - settings hooks + api

**Files:**
- Create: `apps/web/src/features/settings/hooks.ts`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: api.ts 加 settings API**

```typescript
getSettings: () => unwrap(client.api.settings.get()),
getSystemInfo: () => unwrap(client.api.settings.system.get()),
updateSetting: (key: string, value: unknown) =>
  unwrap(client.api.settings({ key }).put({ value })),
```

- [ ] **Step 2: hooks.ts**

```typescript
export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings() });
}
export function useSystemInfo() {
  return useQuery({ queryKey: ["settings-system"], queryFn: () => api.getSystemInfo() });
}
export function useUpdateSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => api.updateSetting(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}
```

- [ ] **Step 3: Commit**

---

## Task 4: 前端 - /system/settings 页面

**Files:**
- Create: `apps/web/src/app/(main)/system/settings/page.tsx`
- Modify: `apps/web/src/components/NavRail.tsx`（加 Settings 入口）

- [ ] **Step 1: 创建 settings 页面**

按领域分 section 的滚动表单：
- Agent Session section（6 项）
- Conversation section（1 项）
- Context Manager section（3 项）
- Runtime section（6 项，带"需重启生效"badge）
- Loop Defaults section（5 项）
- System Info section（只读）

每个 section：Card 包裹 + 标题 + 表单项 + Save 按钮。Save 调 useUpdateSetting。

System Info section：只读展示 env + paths（从 useSystemInfo 获取）。

- [ ] **Step 2: NavRail System 组加 Settings 入口**

- [ ] **Step 3: Commit**

---

## Task 5: 最终验证

- [ ] **Step 1: typecheck + test + biome**
- [ ] **Step 2: Commit + push**
