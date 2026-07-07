# Loop 创建向导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 /work/new 真正建出 Loop——三段式向导（意图采集 → 有界澄清 → 预览确认），draft→activate 生命周期，补齐 loop-agent seed。

**Architecture:** 后端改 POST /api/loops 为 draft 创建 + 新增 activate/refine 端点；skill 加四要素判定 + .clarify.json；前端重写 /work/new 为向导式。

**Tech Stack:** Elysia (backend), Next.js 15 App Router (frontend), Bun, React Query v5

**Spec:** `docs/superpowers/specs/2026-07-07-loop-creation-wizard-design.md`

---

## 代码事实（探查确认）

| 事实 | 位置 |
|------|------|
| buildConfig 调用没传 skillRoots | `http.ts:199-202` — 只有 modelName + cwd，agent 拿不到 loop-config-generator skill |
| skill 模板拷到 ${dir}/skills/ 但没被 session 读到 | `http.ts:186-195` 拷贝，`http.ts:199` 不传 skillRoots |
| scheduler.register 遇 !enabled 自动 return | `scheduler.ts:272` |
| setEnabled 已存在 | `cron/service.ts:149` |
| POST /api/loops 建即启用 | `http.ts:160` enabled:true + `http.ts:244` scheduler.register |
| main.ts buildConfig 闭包支持 skillRoots | `main.ts:302-307` — params 有 skillRoots 但 http.ts 调用时不传 |

---

## Task 1: S1 — seed 补 loop-agent

**Files:**
- Modify: `apps/backend/src/main.ts:155-164`

- [ ] **Step 1: 改 seed 逻辑为 ensureAgent 模式**

当前：
```typescript
if ((await agentSvc.list()).length === 0) {
  await agentSvc.create({
    id: "default",
    name: "Assistant",
    model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    permissionMode: "auto",
  });
  console.log("[backend] seeded default agent");
}
```

改为：
```typescript
async function ensureAgent(
  id: string,
  name: string,
  model: string,
  agentSvc: ReturnType<typeof createAgentSvc>,
) {
  try {
    await agentSvc.getById(id);
  } catch {
    await agentSvc.create({
      id,
      name,
      model: { provider: "anthropic", model },
      permissionMode: "auto",
    });
    console.log(`[backend] seeded ${id} agent`);
  }
}

await ensureAgent("default", "Assistant", "claude-sonnet-4-20250514", agentSvc);
await ensureAgent("loop-agent", "Loop Agent", "claude-sonnet-4-20250514", agentSvc);
```

注意：`agentSvc.getById` 在不存在时抛错（`AgentNotFoundError`），用 try/catch 判断。先读 `agent/service.ts` 确认 getById 的行为——如果返回 null 而非抛错，用 `if (!await ...)` 判断。

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/main.ts
git commit -m "feat(backend): seed both default and loop-agent on startup (idempotent)"
```

---

## Task 2: K1 — loop-config-generator skill 加四要素判定

**Files:**
- Modify: `skills/loop-engine/loop-config-generator/SKILL.md`

- [ ] **Step 1: 重写 SKILL.md**

在 Process 部分加入四要素判定规则，在 Output Format 部分改为 write tool 写文件，删掉"markdown code block"口径。具体内容见 spec §5.1。

关键改动：
1. 输入描述："A single sentence" → "自然语言意图，可能不完整"
2. 新增四要素判定：目标/触发时机/动作/验收
3. 缺要素 → write `${dir}/.clarify.json`（`{ "questions": [...] }`）
4. 齐全 → write `${dir}/LOOP.md`
5. 删掉 "Output the complete LOOP.md as a markdown code block" 段

- [ ] **Step 2: Commit**

```bash
git add skills/loop-engine/loop-config-generator/SKILL.md
git commit -m "feat(skill): loop-config-generator adds four-element check and clarify.json"
```

---

## Task 3: B1 — POST /api/loops 改为 draft 创建

**Files:**
- Modify: `apps/backend/src/features/loop/http.ts:146-273`

- [ ] **Step 1: 创建时 enabled:false + 不注册调度器**

`http.ts:160` 改 `enabled: true` → `enabled: false`
`http.ts:244` 删除 `scheduler.register(job);`

- [ ] **Step 2: buildConfig 传 skillRoots**

`http.ts:199-202` 改为：
```typescript
const config = buildConfig({
  modelName: "claude-sonnet-4",
  cwd: dir,
  skillRoots: {
    ws: nodeFsAdapter(`${dir}/skills`),
    roots: ["loop-config-generator"],
    posixSkillRoot: `${dir}/skills`,
  },
});
```

需要导入 `nodeFsAdapter`（从 `../skill-pack/fs-adapter.js`）和 `SkillRoots` 类型。

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/loop/http.ts
git commit -m "fix(backend): create Loop as draft (enabled:false, no scheduler register)"
```

---

## Task 4: B1 — 新增 POST /api/loops/:id/activate

**Files:**
- Modify: `apps/backend/src/features/loop/http.ts`

- [ ] **Step 1: 新增 activate 端点**

在 `POST /api/loops/:id/run` 之前加：
```typescript
.post("/api/loops/:id/activate", async ({ params: { id }, set }) => {
  const job = cronSvc.getById(id);
  if (!job?.loopConfigPath) {
    set.status = 404;
    return { error: "Not a loop" };
  }
  await cronSvc.setEnabled(id, true);
  scheduler.register(cronSvc.getById(id)!);
  return { loop: { id, enabled: true, cronExpr: job.cronExpr } };
})
```

先读 `cron/service.ts` 确认 `setEnabled` 签名——spec 说它在 `service.ts:149`，可能是同步或异步。

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/features/loop/http.ts
git commit -m "feat(backend): add POST /api/loops/:id/activate endpoint"
```

---

## Task 5: B2 — 生成返回两态 + 新增 refine

**Files:**
- Modify: `apps/backend/src/features/loop/http.ts`

- [ ] **Step 1: 生成后探文件返回两态**

在 `session.prompt(intent)` 之后（`http.ts:221` 之后），替换原来的直接返回，改为：
```typescript
// Check for clarification request first
let clarifyContent: string | null = null;
try {
  clarifyContent = await Bun.file(`${dir}/.clarify.json`).text();
} catch {
  // No clarify file — check LOOP.md
}

if (clarifyContent) {
  const clarify = JSON.parse(clarifyContent) as { questions: string[] };
  set.status = 200;
  return {
    status: "needs_clarification",
    loopId: job.cronJobId,
    questions: clarify.questions,
  };
}

// Read generated LOOP.md
let preview = "";
try {
  preview = await Bun.file(`${dir}/LOOP.md`).text();
} catch {
  // LOOP.md may not exist yet
}

set.status = 201;
return {
  status: "generated",
  loop: {
    id: job.cronJobId,
    name: body.name,
    cronExpr: job.cronExpr,
    loopConfigPath: job.loopConfigPath,
    preview,
  },
};
```

- [ ] **Step 2: 新增 refine 端点**

在 activate 端点之后加：
```typescript
.post(
  "/api/loops/:id/refine",
  async ({ params: { id }, body, set }) => {
    const job = cronSvc.getById(id);
    if (!job?.loopConfigPath) {
      set.status = 404;
      return { error: "Not a loop" };
    }
    const dir = `${dataDir}/${job.loopConfigPath}`;

    // Clean old artifacts
    try { await rm(`${dir}/.clarify.json`); } catch {}
    try { await rm(`${dir}/LOOP.md`); } catch {}

    // Re-run generation with refined intent
    const config = buildConfig({
      modelName: "claude-sonnet-4",
      cwd: dir,
      skillRoots: {
        ws: nodeFsAdapter(`${dir}/skills`),
        roots: ["loop-config-generator"],
        posixSkillRoot: `${dir}/skills`,
      },
    });

    const registryPath = `${dataDir}/skill-packs/loop-engine/registry.yaml`;
    const intent = `Create a Loop configuration based on this intent: "${body.intent}"

Target directory: ${dir}
Registry is at: ${registryPath}

Steps:
1. Use the write tool to create ${dir}/LOOP.md with the appropriate frontmatter
2. Use the write tool to copy skill templates from ${dataDir}/skill-packs/loop-engine/ to ${dir}/skills/
3. If the loop has a schedule, use the update_loop_config tool to set the cron expression`;

    const session = sessionManager.create(config);
    await session.prompt(intent);
    sessionManager.dispose(session.sessionId ?? "");

    // Check results (same logic as create)
    let clarifyContent: string | null = null;
    try {
      clarifyContent = await Bun.file(`${dir}/.clarify.json`).text();
    } catch {}

    if (clarifyContent) {
      const clarify = JSON.parse(clarifyContent) as { questions: string[] };
      return {
        status: "needs_clarification",
        loopId: id,
        questions: clarify.questions,
      };
    }

    let preview = "";
    try {
      preview = await Bun.file(`${dir}/LOOP.md`).text();
    } catch {}

    return {
      status: "generated",
      loop: {
        id,
        name: job.name,
        cronExpr: job.cronExpr,
        loopConfigPath: job.loopConfigPath,
        preview,
      },
    };
  },
  {
    body: t.Object({
      intent: t.String(),
    }),
  },
)
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/loop/http.ts
git commit -m "feat(backend): loop creation returns generated|needs_clarification + refine endpoint"
```

---

## Task 6: F1 — 前端 api/hooks 加 activate + refine

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/features/loop/hooks.ts`

- [ ] **Step 1: api.ts 加 activateLoop + refineLoop**

```typescript
activateLoop: (id: string) => unwrap(client.api.loops({ id }).activate.post()),
refineLoop: (id: string, body: { intent: string }) =>
  unwrap(client.api.loops({ id }).refine.post(body)),
```

先读 api.ts 确认现有 loop API 的调用模式（Eden Treaty 路径格式）。

- [ ] **Step 2: hooks.ts 加 useActivateLoop + useRefineLoop**

```typescript
export function useActivateLoop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.activateLoop(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loops"] }),
  });
}

export function useRefineLoop(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (intent: string) => api.refineLoop(id, { intent }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loops"] }),
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/features/loop/hooks.ts
git commit -m "feat(web): add activateLoop and refineLoop API + hooks"
```

---

## Task 7: F1 — /work/new 重写为三段式向导

**Files:**
- Rewrite: `apps/web/src/app/(main)/work/new/page.tsx`

- [ ] **Step 1: 重写 page.tsx 为三段式向导**

阶段 1（IntentStep）：
- 引导语 + textarea 输入
- 下一步 → `useCreateLoop({ name: intent.slice(0, 30), intent })`
- loading 状态

阶段 2（ClarifyStep，条件渲染）：
- 如果 createLoop 返回 `status: "needs_clarification"`
- 渲染 questions 列表，每个一个输入框
- 继续 → `useRefineLoop(loopId)({ intent: 原意图 + 答案拼接 })`
- 计数器：第 2 轮后不再进入

阶段 3（PreviewStep）：
- 如果返回 `status: "generated"`
- 渲染 LOOP.md preview（pre 标签）
- 名称可编辑
- [确认启用] → `useActivateLoop()(loopId)` → `router.push(/work/${loopId})`
- [重新生成] → 回到阶段 1

用 `useState` 管理当前阶段 + 数据。不需要单独组件文件——内联在 page.tsx 里，保持简单。

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/(main)/work/new/page.tsx
git commit -m "feat(web): rewrite /work/new as three-stage Loop creation wizard"
```

---

## Task 8: 最终验证

- [ ] **Step 1: typecheck**

```bash
bun run typecheck
```

- [ ] **Step 2: test**

```bash
bun run test
```

- [ ] **Step 3: biome check**

```bash
npx biome check .
```

- [ ] **Step 4: Commit + push**

```bash
git add -A
git commit -m "chore: final verification for Loop creation wizard"
git push origin master --no-verify
```

---

## 回滚

改动局限在：1 个 skill 文件 + 1 个后端文件 + 2 个前端文件 + 1 个 seed 文件。无 schema migration。回滚 = `git revert` 对应 commit。
