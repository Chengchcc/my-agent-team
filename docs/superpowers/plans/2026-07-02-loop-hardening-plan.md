# Loop Hardening — 实施 Plan（探索补充版）

> **Baseline:** 25ae5f72 . **Spec:** `docs/superpowers/specs/2026-07-02-loop-hardening.md`
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**探索发现的关键差距（与 spec 合并）：**

| # | 发现 | 具体位置 |
|---|------|---------|
| 1 | `LoopStepParams` 是 **inline 类型**（不是独立 interface） | `loop-step.ts:119-124` |
| 2 | `workDir = params.loopConfigPath` — 完全同义别名 | `loop-step.ts:127` |
| 3 | 所有 4 处 Bun.$ git 命令**无 `.cwd()`** | `loop-step.ts:201,215,216,258` |
| 4 | `scheduler.ts` buildSpec 手搓空壳：`plugins: [], tools: [], {} as any` | `scheduler.ts:134-154` |
| 5 | `scheduler.ts` fireLoop 传 raw `currentJob.loopConfigPath!`（无 `${dataDir}/` 前缀） | `scheduler.ts:99,107` |
| 6 | `buildSessionSpec` 已支持 `skillRoots` 参数 | `session-factory.ts:298-302` |
| 7 | `SkillRoots = { ws: AgentFsLike, roots: string[], posixSkillRoot: string }` | `skill-roots.ts:9` |
| 8 | `ProjectRow` 有 `repoUrl: string|null`, `defaultBranch: string|null` | `project/domain.ts` |
| 9 | `ProjectPort.getProject(projectId) → ProjectRow|null` | `project/ports.ts:22` |
| 10 | registry.yaml 有 7 个 pattern，每个含 `generator.{model,systemPrompt}` + `evaluator.{model,systemPrompt}` | `skills/loop-engine/registry.yaml` |
| 11 | `constraints.md` **不存在**；denylist/budget 在 LOOP.md frontmatter 中定义 | `loop-config-generator/SKILL.md:50-59` |
| 12 | Web: Review Queue 硬编码占位，reviewMu 声明但未使用 | `loops/[id]/page.tsx:92-114` |
| 13 | Web: NavRail Loops 项出现两次（line ~292 和 ~311） | `NavRail.tsx` |
| 14 | Web: hooks.ts toggle onSuccess 只 invalidate `loopKeys.all` | `hooks.ts:25` |
| 15 | `LoopConfig` frontmatter 模板字段: `budget.dailyCap`, `safety.denylist`, `safety.maxRetries`, `safety.autoMerge` | `loop-config-generator/SKILL.md:50-59` |

---

## PR1（S1 止血 + skill 装配）

### Task 1: repoPath 从 project 派生 + git cwd

**涉及文件:**
- Modify: `apps/backend/src/features/loop/loop-step.ts`（265 行）
- Read: `apps/backend/src/features/project/{domain,ports}.ts`

**Step 1.1: LoopStepParams 加 projectPort + dataDir**

现状 `loop-step.ts:119-124`：
```ts
export async function loopStep(params: {
  loopConfigPath: string;
  sessionFactory: SessionFactory;
  buildSpec: (params: { sessionId: string; modelName: string; cwd: string }) => SessionSpec;
  action?: ReviewAction;
}): Promise<LoopState>
```

改为独立 `LoopStepParams` 接口，加 `projectPort: ProjectPort` 与 `dataDir: string`。

**Step 1.2: 从 LOOP.md 读 projectId 派生 repoPath**

```ts
const config = parseLoopConfig(await Bun.file(`${params.loopConfigPath}/LOOP.md`).text());
const project = config.projectId ? params.projectPort.getProject(config.projectId) : null;
if (!project?.repoUrl) throw new Error(`loopStep: project ${config.projectId} has no repoUrl`);
const repoPath = `${params.dataDir}/repos/${config.projectId}`;
```

**Step 1.3: clone/fetch 保证干净基线**

参考 `skill-pack/tools.ts` 的 clone 先例，用 `Bun.$` + `.nothrow()`。

**Step 1.4: 启动校验**

```ts
const ok = (await Bun.$`git -C ${repoPath} rev-parse --is-inside-work-tree`.quiet().nothrow()).exitCode === 0;
if (!ok) throw new Error(`...`);
```

**Step 1.5: 所有 git 命令 .cwd(repoPath)**

`loop-step.ts:201,215,216,258` 四处，统一 `$git` template tag：
```ts
const $git = (s, ...v) => Bun.$(s, ...v).cwd(repoPath).quiet();
```

`workDir` 拆为 `loopConfigPath`（配置/SKILL/STATE.md）和 `repoPath`（git + session cwd）。

**Step 1.6: 回归测试**

后端仓库有未提交改动 → 跑 loopStep（generator 制造 diff → REJECT → reset），断言后端仓库改动无损。

---

### Task 2: 复用 buildSessionSpec + 按角色装配 skill

**涉及文件:**
- Modify: `apps/backend/src/features/span/session-factory.ts`（325 行）
- Modify: `apps/backend/src/features/cron/scheduler.ts`（250 行）
- Modify: `apps/backend/src/features/loop/loop-step.ts`

**Step 2.1: BuildSessionSpecParams 加 cwdOverride + extraSystemPrompt**

`session-factory.ts:234` 的 `buildSessionSpec` 签名扩展：
- `cwdOverride?: string` — 给定时替换 `join(config.dataDir, "agents", agentId)`
- `extraSystemPrompt?: string` — 拼入 spec system prompt

**Step 2.2: scheduler.ts buildSpec 替换**

删 `scheduler.ts:134-154` 手搓空壳。改为薄封装调用 `buildSessionSpec`（类似 `http.ts` 的做法），入参新增：
```ts
role: "generator" | "evaluator"
skillRoots: SkillRoots
systemPrompt?: string
```

**Step 2.3: 按角色构造 skillRoots**

loopStep 内按角色构造：
```ts
function loopSkillRoots(loopConfigPath: string, skillName: string): SkillRoots {
  const root = `${loopConfigPath}/skills`;
  return { ws: nodeFsAdapter(root), roots: [skillName], posixSkillRoot: root };
}
// generator: loopSkillRoots(loopConfigPath, "loop-generator")
// evaluator: loopSkillRoots(loopConfigPath, "loop-verifier")
```

**Step 2.4: 注入 registry 角色 systemPrompt**

从 LOOP.md 解析出的 `generator.systemPrompt` / `evaluator.systemPrompt` 经 `extraSystemPrompt` 注入。

**Step 2.5: http.ts create-loop 用 loop-config-generator**

`http.ts:144` 的 spec skillRoots 指向 `loop-config-generator`。

**Step 2.6: 验证测试**

- generator session spec.tools 含 write/bash（非空）
- skillRoots.roots === ["loop-generator"]，skill-load 可加载
- evaluator skillRoots.roots === ["loop-verifier"]，generator 加载 verifier skill 应失败
- registry 角色 systemPrompt 出现在对应 session

---

### Task 3: resolveLoopPaths 统一

**涉及文件:**
- Create: `apps/backend/src/features/loop/resolve-paths.ts`
- Modify: `scheduler.ts:99,107`, `http.ts:229,246`

```ts
export function resolveLoopPaths(job: CronJobRow, dataDir: string) {
  return { loopConfigPath: `${dataDir}/${job.loopConfigPath}` };
}
```

scheduler 的 `currentJob.loopConfigPath!` → `resolveLoopPaths(currentJob, dataDir).loopConfigPath`。http.ts 的手拼 `${dataDir}/` → helper。

---

### Task 4: VERDICT.md 生命周期

**涉及文件:**
- Modify: `loop-step.ts:242`

当前 `loop-step.ts:242`：
```ts
const verdictMd = await Bun.file(`${workDir}/VERDICT.md`).text().catch(() => "");
```

改为：
```ts
await Bun.$`rm -f ${repoPath}/VERDICT.md`.quiet(); // 起 evaluator 前
// ... evaluator 跑完 ...
const verdictMd = await Bun.file(`${repoPath}/VERDICT.md`).text().catch(() => "");
if (!verdictMd.trim()) {
  // 构造 {verdict:"ESCALATE", reasons:["evaluator produced no verdict"], evidence:""}，转 inbox
}
```

---

## PR2（P0 约束 + ADR）

### Task 5: per-loop 写锁

**涉及文件:** `loop-step.ts`

模块级 Promise chain 互斥锁：
```ts
const loopLocks = new Map<string, Promise<unknown>>();
async function withLoopLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = loopLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  loopLocks.set(key, next.catch(() => {}));
  return next;
}
```

### Task 6: model ≠ 校验 + 预算闸门

**涉及文件:** `loop-step.ts`, `packages/loop/src/state-md.ts`

- model 校验：`config.generator.model === config.evaluator.model → throw`
- 预算：进程内计数器（Map）+ 可选 `budget.json`。LOOP.md frontmatter `budget.dailyCap`（`loop-config-generator/SKILL.md:55`）。计数来源：checkpointer/usage。

### Task 7: maxParallelFindings 并发池

**涉及文件:** `loop-step.ts`

手写信号量，上限 = LOOP.md frontmatter `maxParallelFindings`（缺省 1）。STATE.md 写回在 loopStep 末尾原子完成。

### Task 8: ADR 0006 修订 + denylist

**涉及文件:** `docs/adr/0006-loop-lock-deferred.md`, `loop-step.ts`

- ADR：追加 2026-07-02 修订段
- denylist：从 LOOP.md `safety.denylist` 读，注入 system prompt，触碰记 evidence

---

## PR3（reducer 死角 + Web 接线）

### Task 9: PASS + 空 evidence

**涉及文件:** `packages/loop/src/loop-reducer.ts:52`

当前 `if (isEvidenceEmpty(verdict.evidence)) break;` → 改 inbox + ESCALATE。

### Task 10: reasons 序列化往返

**涉及文件:** `packages/loop/src/state-md.ts:275`

废弃 `split(",")`，统一 JSON 数组编解码。加往返测试。

### Task 11: Web review 接线

**涉及文件:**
- `apps/web/src/app/(main)/loops/[id]/page.tsx`（136 行）
- `apps/web/src/features/loop/hooks.ts`
- `apps/web/src/components/NavRail.tsx`

**现状:**
- Review Queue（line 92-114）：硬编码占位 Card，Approve/Reject 按钮无 onClick
- `reviewMu`（line 20）声明但从未使用
- NavRail 有重复 Loops 项（~line 292 + ~line 311）
- `hooks.ts:25`: toggle onSuccess 只 `invalidateQueries({ queryKey: loopKeys.all })`
- `hooks.ts:43`: `verdict: string` 非 union

**改为:**
- map `loop.items` filter `step === "awaiting_review"` 真实渲染
- reviewMu.mutate 接 Approve/Reject/Promote
- toggle onSuccess 加 `cronKeys.all`
- verdict: `"approve"|"reject"|"promote"|"retry"|"dismiss"`
- NavRail 删除重复项

### Task 12: 全量校验

- `bun run typecheck` 全绿
- `bun test` 全绿
- spec §10 验收清单逐条勾选
