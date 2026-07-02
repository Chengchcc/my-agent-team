# Loop Hardening Spec — 回路止血 + P0 约束落地 + Web review 接线

> **Status:** 🏗 Design → Implementation
> **Baseline:** 25ae5f72（M1–M6 全实现完成态）
> **关联:** `apps/backend/src/features/loop/loop-step.ts` · `apps/backend/src/features/cron/scheduler.ts` · `apps/backend/src/features/loop/http.ts` · `apps/backend/src/features/project/{domain,service}.ts` · `apps/backend/src/features/span/{session-factory,skill-roots}.ts` · `packages/loop/src/{loop-reducer,state-md}.ts` · `apps/web/src/app/(main)/loops/[id]/page.tsx` · `apps/web/src/features/loop/hooks.ts` · `docs/adr/0006-loop-lock-deferred.md` · `docs/prd/loop-engineering.md`

**Goal:** 修复 M1–M6 Loop 实现里三类问题——(1) 让回路真正跑得通且不损坏后端仓库；(2) 把 PRD 标 P0、被 ADR 0006 以「M4 只有 cron 一条入口」为由延后、而该前提已被 M5/M6 三入口 API 推翻的硬约束落地；(3) 补齐前端人工 review 断路。以 25ae5f72 为准，逐条对齐 PRD 不变量与 e2e-loop-verification 时序。

**Non-goals:**
- 不改文件态模型（STATE.md 仍是 item 状态单一真相源，不新增 DB 表；唯一 DB 改动仍是 `cron_job.loop_config_path`）
- 不改 loopReducer 已实现的 action 集合语义（TICK/GENERATOR_DONE/EVALUATOR_VERDICT/APPROVE/REJECT_HUMAN/PROMOTE/RETRY/DISMISS/ADD_ITEM）——只补它没覆盖到的死角
- 不做 Loop 配置的 git 版本控制策略（PRD 开放问题，另议）
- 不重写 skill-pack 模板内容

---

## 1. 问题清单与不变量映射

每条修复都锚定一个已被违反的 PRD/ADR/flow 不变量。严重度 S1 = 回路跑不通或损坏数据，S2 = 语义退化，S3 = UI 断路。

| # | 严重度 | 位置 | 违反的不变量 |
|---|--------|------|-------------|
| 1 | S1 | `loop-step.ts:201/215/216/258` git 命令无 cwd，且 `workDir=loopConfigPath` 本非目标仓库 | flow：Generator/Evaluator「共享工作区」应指向 project 派生的目标仓库副本；`git reset --hard` 必须作用于隔离副本，不得触及后端进程仓库 |
| 2 | S1 | `scheduler.ts:134` `buildSpec` 返回空 `plugins:[]/tools:[]` 且**不传 skillRoots** | PRD：Generator/Evaluator 是能动手改代码/跑测试的 AgentSession，且需按角色装配 loop-generator / loop-verifier skill |
| 3 | S1 | cron 与 http 传给 loopStep 的 `loopConfigPath` 口径不一致 | PRD：STATE.md 是 item 状态单一真相源（不得分叉到两个路径） |
| 4 | S1 | `loop-step.ts:242` VERDICT.md 从不清理 | flow：「读 verdict 内容」必须是**本 item 本轮**的判决，不得串味 |
| 5 | S1 | 写锁 / 原子预算 / model≠校验 全缺失 | PRD P0；ADR 0006 的豁免前提（M4 单入口）已被 M5/M6 推翻 |
| 6 | S2 | `loop-reducer.ts:52` PASS + 空 evidence → break 卡死 | flow：verifying 是过渡态，不得成为吸收态 |
| 7 | S2 | `state-md.ts:275` reasons 用 `split(",")` | 多行/含逗号 reasons 往返损坏 |
| 8 | S3 | `loops/[id]/page.tsx:93-112` Review Queue 硬编码占位 | PRD：人工 review 是 awaiting_review→resolved 的 P0 闸门 |
| 9 | S3 | `hooks.ts:25` toggle 只刷 loopKeys | Pause/Resume 改的是 cron_job，cron 列表不刷新 |
| 10 | S3 | `hooks.ts:43` `verdict: string` | 与后端 5 值 union 脱钩，拼错值编译期不报 |
| 11 | S3 | `NavRail.tsx:292/311` Loops 渲染两次 | 导航重复项 |

---

## 2. 目标工作区模型：repo 走 project 派生（修复 #1 的前提）

现状 `loop-step.ts:127` 把 `workDir = params.loopConfigPath`——即 `.loop` 配置目录本身，而 git 命令又缺 cwd。两个错误叠加：git 落在后端进程 cwd，`reset --hard` 炸后端仓库。

**决策：repo 不做 LOOP.md 手填字段，而由 `project` 模型派生。** loop 已通过 LOOP.md frontmatter 的 `projectId` 关联 project（`state-md.ts:290/309`），`project` 表已有 `repoUrl` + `defaultBranch`（`domain.ts:4-5`）。因此引入 **两个独立路径**：

```
loopConfigPath   →  .loop 配置目录（LOOP.md / STATE.md / INBOX.md / skills/ 所在）
repoPath         →  被修改的目标代码仓库本地工作副本根（git 命令的 cwd；Generator/Evaluator session 的 cwd 也指向这里）
```

- `repoPath` 解析链（全部经 `projectId`，不接受手填绝对路径）：
  1. loopStep 从 LOOP.md 读 `projectId` → 查 `projectPort.getProject(projectId)` 拿 `repoUrl` + `defaultBranch`。
  2. 该 project 的本地工作副本落在约定目录 `${dataDir}/repos/${projectId}`（新目录，语义与 skill-pack 的 clone 一致）。
  3. 首次不存在 → `git clone <repoUrl> --branch <defaultBranch>`（复用 `skill-pack/tools.ts:116` 的 clone 先例做法，浅克隆）；已存在 → `git fetch` + `git checkout <defaultBranch>` + `git reset --hard origin/<defaultBranch>` 保证干净基线。
  4. `projectId` 缺失 / project 无 repoUrl → 抛错终止，不再静默 fallback 到 loopConfigPath。
- 派生出的 `repoPath = ${dataDir}/repos/${projectId}` 即所有 git 命令与 session 的 cwd。
- 所有 `Bun.$` git 命令统一 `.cwd(repoPath)`：

```ts
const $git = (strings, ...values) => Bun.$(strings, ...values).cwd(repoPath).quiet();
const baseSha = (await $git`git rev-parse HEAD`).text().trim();
// ...
await $git`git reset --hard ${baseSha}`;
```

- **启动即校验**：loopStep 在 clone/checkout 后断言 `git -C repoPath rev-parse --is-inside-work-tree` 为真；否则抛错终止，绝不在错误目录跑 `reset --hard`。
- 本地工作副本是 loop 专属的隔离目录（`${dataDir}/repos/${projectId}`），与后端进程自身仓库彻底分离——这才是「共享工作区」的正确落点。`reset --hard` 只作用于此副本。

> `LoopConfig` 不再需要 `repoPath` 字段；派生完全靠 `projectId` + project 记录。多个 loop 共享同一 projectId 时复用同一本地副本，需与写锁（§6.1）配合串行化对该副本的 checkout/reset。

---

## 3. Session spec 复用 + 分角色 skill 装配（修复 #2，本轮重点）

删掉 `scheduler.ts:134` 手搓的 `buildSpec` 空壳，改为复用 `buildSessionSpec()`（`session-factory.ts:234`）——真实 run 正是靠它装配 `createReadTool/createWriteTool/createEditTool/bashTool/globTool/grepTool` + `identityPlugin/fsMemoryPlugin/progressiveSkillPlugin` + checkpointer + contextManager。**但仅补齐工具还不够**：现状 `buildSpec` 完全没传 `skillRoots`，导致 generator/evaluator 拿不到自己的角色 skill——回路即使有 bash/write，也不知道「按什么套路干活」。

### 3.1 分角色 skill 装配（核心）

loop 的 skill 是**按角色划分**的（`skills/loop-engine/` 下 `loop-triage` / `loop-generator` / `loop-verifier` / `loop-config-generator`），创建 loop 时已 copy 进 `${loopConfigPath}/skills/`（`http.ts:130-138`）。装配规则：

| session 角色 | 装配的 skill | systemPrompt 来源 |
|-------------|-------------|-------------------|
| Generator | `loop-generator`（+ 如需 `loop-triage`） | registry pattern 的 `generator.systemPrompt` |
| Evaluator | `loop-verifier` | registry pattern 的 `evaluator.systemPrompt` |
| Create-loop（http create） | `loop-config-generator` | 现有 intent prompt |

- `buildSpec` 增加 `role: "generator" | "evaluator"` 与 `skillRoots` 入参。`skillRoots` 指向该 loop 的 `.loop/skills/`（而非 `buildSkillRoots` 走的共享 `${dataDir}/skill-packs`），使 progressiveSkillPlugin 的 `roots` 能发现并 `skill-load` 到本 loop 的角色 skill。
- `skillRoots` 构造：`{ ws: nodeFsAdapter(`${loopConfigPath}/skills`), roots: [<角色对应 skill 目录名>], posixSkillRoot: `${loopConfigPath}/skills` }`。roots 按角色只放该角色的 skill，避免 generator 看到 verifier 的 skill 反之亦然。
- registry.yaml 的 `generator.systemPrompt` / `evaluator.systemPrompt` 注入对应 session 的 system prompt（现状这两个 prompt 在 registry 里定义但从未接到 session）。

### 3.2 spec 基座与 cwd

```ts
// scheduler.ts / loop-step.ts —— buildSpec 改为按角色薄封装
function buildSpec(params: {
  sessionId: string; modelName: string; cwd: string;   // cwd = repoPath
  role: "generator" | "evaluator" | "config";
  skillRoots: SkillRoots;                                // 指向 .loop/skills 的角色子集
  systemPrompt?: string;                                 // registry 的角色 prompt
}): SessionSpec {
  return buildSessionSpec({
    agentId: "loop-agent",
    agent: { modelName: params.modelName, modelProvider: "anthropic", modelBaseUrl: null },
    config: deps.config,
    makeModel: deps._makeModel,
    cwdOverride: params.cwd,        // = repoPath，工具沙箱落在目标仓库副本
    skillRoots: params.skillRoots,  // 角色 skill
    extraSystemPrompt: params.systemPrompt,
  });
}
```

- `cwd`：`buildSessionSpec` 内部按 `agentId` 派生 cwd 用于工具沙箱；loop 场景需覆写为 `repoPath`（generator/evaluator 要在目标仓库副本动手）。为此给 `BuildSessionSpecParams` 加可选 `cwdOverride`，构造后 read/write/edit/bash 工具与 spec.cwd 一致。
- `buildSessionSpec` 已支持 `skillRoots` 入参（`session-factory.ts:230-231`），直接复用；需新增 `extraSystemPrompt` 透传角色 prompt。
- `checkpointer`/`contextManager` 由 `buildSessionSpec` 提供真实实现，删掉 `{} as any`。

### 3.3 验证锚点

- generator session 的 skillRoots.roots 含 `loop-generator`，`skill-load` 可加载到它；evaluator 含 `loop-verifier`。
- 断言 generator session **看不到** verifier skill（roots 隔离）。
- registry 的角色 systemPrompt 出现在对应 session 的 system prompt 中。

---

## 4. loopConfigPath 口径统一（修复 #3）

三个调用点必须传同一绝对路径：

- `scheduler.ts:99/107` fireLoop 现传 `currentJob.loopConfigPath!`（相对）
- `http.ts:229/246` run/review 现传 `${dataDir}/${job.loopConfigPath}`（带前缀）

**决策：`cron_job.loop_config_path` 存储相对 dataDir 的相对路径（现状 DB 语义），在传入 loopStep 前统一拼 `${dataDir}/`。** 抽一个 `resolveLoopPaths(job, dataDir)` helper 返回 `{ loopConfigPath, repoPath }`，三处调用点全部走它，杜绝口径漂移。scheduler 与 http 都 import 同一 helper。

---

## 5. VERDICT.md 生命周期（修复 #4）

```ts
// 每个 item 起 evaluator 前
await Bun.$`rm -f ${repoPath}/VERDICT.md`.quiet();   // 或 loopConfigPath，取实际约定位置
// ... evaluator 跑完
const verdictMd = await Bun.file(verdictPath).text().catch(() => "");
if (!verdictMd.trim()) { /* 缺判决 → 视为 ESCALATE，item 转 inbox，不静默 PASS */ }
```

- 读前先删，确保读到的一定是本 item 本轮 evaluator 写的。
- evaluator 未产出 VERDICT.md（工具失败/超时）→ 构造 `{verdict:"ESCALATE", reasons:["evaluator produced no verdict"], evidence:""}`，转 inbox。不得因文件缺失而让 item 悬空。

---

## 6. P0 硬约束落地（修复 #5）

ADR 0006 把这三件事标「MVP 不做」，理由是 M4 只有 cron 一条入口。25ae5f72 里 M5（`/run`、`/review` HTTP）+ M6（Web review）已落地三入口，且 `buildSpec` 已接真实 anthropic model——ADR 的三条前提全部失效（**已确认翻转**）。本 spec 落地这些约束，并改写 ADR 0006 记录前提失效与决策翻转（见 §9）。

### 6.1 per-loop 写锁

cron / manual run / review 三入口共用一把 per-`loopConfigPath` 的进程内互斥锁，序列化对 STATE.md 的读-改-写：

```ts
// loop-step.ts —— 模块级 Map<loopConfigPath, Promise chain> 串行化
const loopLocks = new Map<string, Promise<unknown>>();
async function withLoopLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = loopLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  loopLocks.set(key, next.catch(() => {}));
  return next;
}
```

- loopStep 整体包在 `withLoopLock(loopConfigPath, ...)` 内。
- 与 cron scheduler 现有 `inFlight`（防 cron 自重叠）正交：inFlight 只挡同一 cron job 的重叠触发，写锁挡的是**跨入口**（cron 正跑时 review 打进来）。
- 单进程假设成立（backend 单实例）；多实例部署时需换文件锁，列为已知边界写进 ADR。

### 6.2 原子预算计数

- per-loop token 预算不落 STATE.md（避免与状态读写争锁、避免频繁重写）。用独立的进程内计数器 + 可选落 `budget.json`（单独文件，原子写）。
- Generator/Evaluator 起 session 前查 `used < cap`；超 cap 则该 item 跳过并在 STATE.md 标记 `budget_exceeded`，不再起 session。
- cap 从 `LOOP.md` frontmatter `budget.maxTokens` 读，缺省给保守默认。
- 计数来源：session 完成后从 checkpointer/usage 累加（不直接调 LLM Gateway）。

### 6.3 generator ≠ evaluator model 启动校验

```ts
if (config.generator.model === config.evaluator.model) {
  throw new Error("Loop config invalid: generator.model must differ from evaluator.model");
}
```

- 在 loopStep 读完 LOOP.md config 后立即校验，早失败。
- 对齐 flow「Evaluator model ≠ generator，怀疑姿态」与 PRD「分模型独立 AgentSession」。

### 6.4 denylist / budget 注入 prompt（随 §6.2 一起）

- 把 `constraints.md` 的 denylist 注入 generator/evaluator system prompt（merge-only-add 语义），并在工具层对触碰 denylist 路径的写操作拦截。本轮先做 prompt 注入 + 记录违规到 evidence；工具层强制拦截列为 §11 后续项。

### 6.5 maxParallelFindings + AgentSession 池

- 现状 loopStep 串行处理一个 fixing item。落地 `maxParallelFindings`（LOOP.md frontmatter，缺省 1）：用有界并发（`p-limit` 式手写信号量）并行处理 fixing items，上限即池大小。
- 缺省 1 时行为与现状完全一致（零回归）；>1 时受锁保护的 STATE.md 写回仍在 loopStep 末尾一次性原子完成。

---

## 7. Reducer 死角（修复 #6、#7）

### 7.1 PASS + 空 evidence（loop-reducer.ts:52）

现状 `if (isEvidenceEmpty(verdict.evidence)) break;` → item 卡在 verifying。改为：空 evidence 的 PASS 视为无效判决，转 inbox 并附 reason，不静默：

```ts
if (verdict.verdict === "PASS") {
  if (isEvidenceEmpty(verdict.evidence)) {
    items[action.itemId] = { ...item, step: "inbox",
      result: { verdict: "ESCALATE", reasons: ["PASS verdict missing evidence"], evidence: "" } };
    break;
  }
  items[action.itemId] = { ...item, step: autoResolve ? "resolved" : "awaiting_review", result: verdict };
}
```

### 7.2 reasons 序列化往返（state-md.ts:275）

`parseVerdictMd` 用 `split(",")` 拆 reasons，与写入侧的多行/JSON 结构不一致。统一 reasons 序列化为 YAML 列表或 JSON 数组，读写两侧用同一编解码，禁止逗号 split。加往返测试（write→parse→deepEqual）。

---

## 8. Web review 接线（修复 #8、#9、#10、#11）

### 8.1 Review Queue 真渲染（loops/[id]/page.tsx）

后端 `http.ts:66` GET detail 已返回 `items[]`。前端删掉 §93-112 的硬编码占位，改为：

```tsx
{loop.items.filter(i => i.step === "awaiting_review").map(item => (
  <Card key={item.id}><CardContent className="p-3 flex items-center justify-between">
    <span className="text-sm">{item.summary}</span>
    <div className="flex gap-2">
      <Button size="sm" onClick={() => reviewMu.mutate({ itemId: item.id, verdict: "approve" })}>Approve</Button>
      <Button size="sm" variant="outline" onClick={() => reviewMu.mutate({ itemId: item.id, verdict: "reject" })}>Reject</Button>
      <Button size="sm" variant="ghost" onClick={() => reviewMu.mutate({ itemId: item.id, verdict: "promote" })}>Promote</Button>
    </div>
  </CardContent></Card>
))}
```

`reviewMu`（已在 :20 声明）真正被调用。

### 8.2 toggle 刷新 cronKeys（hooks.ts:25）

Pause/Resume 改的是 cron_job，`onSuccess` 需同时 `invalidateQueries({ queryKey: cronKeys.all })` 与 `loopKeys.all`。

### 8.3 verdict 类型收紧（hooks.ts:43）

```ts
mutationFn: (body: { itemId: string; verdict: "approve"|"reject"|"promote"|"retry"|"dismiss"; feedback?: string }) => ...
```

理想是从 Eden Treaty 推导后端 union，避免手抄；至少先收成字面量 union。

### 8.4 NavRail 去重（NavRail.tsx:292/311）

删掉重复的第二个 Loops 项；Issues 保留/移除按产品动线定（本 spec 只去重复项，Issues 存废另议）。

---

## 9. ADR 0006 处置

新增一条决策修订到 `docs/adr/0006-loop-lock-deferred.md`（或补 superseding note）：

> **2026-07-02 修订：** M5（`/run`、`/review` HTTP）与 M6（Web review）已落地三入口，`buildSpec` 已接真实 anthropic model。ADR 0006 原三条豁免前提（M4 单入口 / 无真实 model / 单 item 串行）全部失效。据此翻转决策：per-loop 写锁、原子预算计数、model≠校验、maxParallelFindings 池由 loop-hardening 落地。单进程内存锁为当前边界，多实例部署需升级为文件/分布式锁。

---

## 10. 验收标准

- [ ] loopStep 全程 git 命令作用于 project 派生的 `repoPath`（`${dataDir}/repos/${projectId}`）；构造一个后端仓库有未提交改动的场景，跑 loop 后端仓库改动**无损**（回归测试）。
- [ ] projectId 缺失 / project 无 repoUrl 时 loopStep 启动即抛错，不 fallback。
- [ ] generator session 装到 `loop-generator` skill 且 skillRoots 指向 `.loop/skills`；evaluator 装到 `loop-verifier`；两者 roots 互不可见（skill 隔离测试）。
- [ ] registry 的 `generator.systemPrompt` / `evaluator.systemPrompt` 出现在对应 session 的 system prompt。
- [ ] generator/evaluator session 具备 read/write/edit/bash/glob/grep 工具（断言 spec.tools 非空）。
- [ ] cron 与 http 两入口对同一 loop 落在同一 STATE.md（`resolveLoopPaths` 单测）。
- [ ] 连续两个 item，第二个 evaluator 未写 VERDICT.md 时不会读到第一个的判决（转 inbox）。
- [ ] 写锁：并发 run+review 对同一 loop 串行执行，STATE.md 无覆盖丢失（并发测试）。
- [ ] generator.model === evaluator.model 时 loopStep 启动即抛错。
- [ ] PASS+空 evidence → item 落 inbox 而非卡 verifying（reducer 单测）。
- [ ] reasons 含逗号/多行 write→parse 往返 deepEqual。
- [ ] Web 详情页 awaiting_review item 渲染出卡片，Approve/Reject/Promote 点击触发 review 并刷新。
- [ ] Pause/Resume 后 cron 列表与 loop 列表同步刷新。
- [ ] `bun run typecheck` + `bun test` 全绿。

---

## 11. 后续项（本 spec 不做）

- denylist 的**工具层强制拦截**（本轮仅 prompt 注入 + evidence 记录）。
- 多实例部署的分布式写锁 / 预算计数（当前单进程内存锁）。
- Loop 配置的 git 版本控制策略（PRD 开放问题）。
- Issues 导航项存废（产品动线决策）。
