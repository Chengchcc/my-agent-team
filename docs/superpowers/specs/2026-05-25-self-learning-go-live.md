# Self-Learning Go-Live Spec — 接通 evolution.review 与 memory.extract 的 LLM 通路

> **Status**: Draft (design-only, no code)
> **Owner**: TBA
> **Tracks**: `evolution/worker-entry.ts` LLM 接入、`memory/extract-worker.ts` LLM 接入、`JobSpawner` 协议升级、ProviderInvoke 跨进程桥、evolution `promote` 落盘到 skills/
> **Cross-refs**: 复用 [self-evolution-design.md](./2026-05-06-self-evolution-design.md) 与 [self-evolution-phase3-design.md](./2026-05-07-self-evolution-phase3-design.md) 的策略与 prompt;复用 [hybrid-memory-retrieval-design.md](./2026-05-11-hybrid-memory-retrieval-design.md) 的召回侧。本 spec 只补"写入 / 抽取 / 接 LLM"这条死路

---

## 0. 目标与非目标

### 0.1 目标
1. **打通 evolution 自我进化的最后 1 cm**:让 `evolution/worker-entry.ts` 真正调 LLM,而不是永远 `parseVerdict('{}', job)` → outcome:`inconclusive`。
2. **打通 memory 自我记忆的最后 1 cm**:让 `memory/extract-worker.ts` 真正调 LLM 并解析 `#tag` 候选,而不是永远 `return { candidates: [] }`。
3. **统一两个 worker 的 LLM 接入模式**:同一份 `JobContext` 注入协议,inproc / spawn 两种 spawner 行为一致。
4. **完成 `evolution.promote` 的落盘闭环**:接受的 proposal 写成 `SKILL.md` 到 `paths.skills.agent` 并触发 `skills.reload`,让 agent 下一轮真用上。
5. **memory.extract 加最小写入正确性**:type 不再写死 `'general'`、tag → type 映射、入库前去重(text + type)。

### 0.2 非目标(故意不做)
- ❌ **重写 evolution prompt**。`buildPrompt` 已存在且正确(已渲染 `TraceRun`),只用其产物。
- ⚠️ **修补 `buildExtractPrompt`**(原本写死 user message,忽略 `_job`)。本 spec **必须**补对称的 `formatRun()` 渲染,否则即便接通 LLM,模型也看不到对话——纯空转。
- ❌ **多模型路由 / 模型选择 UI**。worker 用同一个 `provider.llm`,不做模型自适应。
- ❌ **memory 衰减、usage_count 自动 bump、矛盾合并**。属于"记忆生命周期"下一个 spec,不在此处展开(评估见 §6)。
- ❌ **evolution Tier2 自动 retire**。本 spec 只写出 verdict 与 proposal;`retire` 仍需人工 `/evolution discard` 或后续 spec 自动化。
- ❌ **持久化 in-flight 队列、断点续跑**。worker 失败就 `inconclusive`,跑下一轮即可。
- ❌ **统一 `JobSpawner` 协议变更"波及业务"**。本 spec 只动两个现有 worker 与 spawner 自身;其他 worker(目前没有)以后照此模式接。
- ❌ **Bun spawn 子进程的 LLM 双向 RPC 桥**。spawn 模式留给未来不需要 LLM 的纯计算 worker;本 spec 的两个 worker 默认走 inproc。spawn + LLM 工作流留给 follow-up `lobster-spawn-llm-bridge`。

---

## 1. 现状定位:两条死路的同一个根因

```
evolution/index.ts            memory/index.ts
       │                            │
       ▼                            ▼
spawner.run({                spawner.run({
  entry: worker-entry,         entry: extract-worker,
  job: ReviewJob,              job: ExtractJob,
  timeoutMs: 120s              timeoutMs: 60s
})                           })
       │                            │
       ▼                            ▼
InprocJobSpawner / BunSpawnJobSpawner
       │
       ▼
mod.handle(job)         ← ✋ 只能拿到 job,拿不到 provider
       │
       ▼
buildPrompt(job)
// TODO: LLM call via ProviderInvoke
return parseVerdict('{}', job)   ← 永远空
```

**核心矛盾**:
- `JobSpawner` 协议 `handle(job): Promise<TResult>` 只能传 JSON-safe 的 job,无法塞 `ProviderInvoke` 实例。
- `InprocJobSpawner` 跑在 host 进程,理论上 *可以* 从注册表拿 provider,但 `handle(job)` 签名不接受第二参数 → 无入口。
- `BunSpawnJobSpawner` 跑真子进程,host 注册表对象本就不可序列化跨进程 → 必须走 RPC/桥。

**结论**:必须把"调 LLM"这件事从 worker 抽象出来,改由 spawner 把一个最小能力对象(`JobContext`)注入到 worker。

---

## 2. 架构变更

### 2.1 `JobSpawner` 协议升级

| 文件 | 变更 |
|---|---|
| `application/ports/job-spawner.ts` | 新增 `JobContext { invoke: InvokeFn; logger?: Logger }`;`run()` 第二实参 `ctxFactory: () => JobContext` |
| `application/ports/job-spawner.ts` | 约定 worker 必须 export `handle(job, ctx)` 签名;旧单参签名以"可选"形式兼容(过渡期) |
| `infrastructure/jobs/inproc-job-spawner.ts` | 透传 host 的 `JobContext` 给 `handle` |
| `infrastructure/jobs/bun-spawn-job-spawner.ts` | 启动子进程时建立 stdin/stdout JSON-RPC 通道,worker 内部把 `ctx.invoke` 实现为对 stdin 写 `{kind:'invoke', req}`、监听 stdout 拿 `{kind:'result', resp}` |

**新协议**:

```ts
// application/ports/job-spawner.ts
export interface InvokeFn {
  (req: {
    purpose: string         // 'evolution.review.tier0' | 'memory.extract' 等
    messages: Array<{ role: string; content: string }>
    maxTokens?: number
  }): Promise<{ content: string; usage: { input: number; output: number } }>
}

export interface JobContext {
  invoke: InvokeFn
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export interface JobSpawner {
  run<TJob, TResult>(opts: {
    entry: string
    job: TJob
    ctx: JobContext            // ← 新增,必填
    timeoutMs?: number
  }): Promise<TResult>
}
```

### 2.2 Inproc spawner 实现

```ts
// infrastructure/jobs/inproc-job-spawner.ts
async run<TJob, TResult>({ entry, job, ctx }) {
  const mod = await import(entry)
  if (typeof mod.handle !== 'function') throw new Error(...)
  return await mod.handle(job, ctx) as TResult
}
```

直接把 host 的 `ctx` 透传。零序列化、零进程开销。

### 2.3 Bun spawn spawner 实现（降级处理）

spawn 模式不支持 `JobContext.invoke`,因为函数对象无法跨进程序列化,且双向 RPC 桥的实现成本远超本 spec 范围。

```ts
// infrastructure/jobs/bun-spawn-job-spawner.ts
async run<TJob, TResult>({ entry, job, ctx, timeoutMs }) {
  if (ctx && ctx.invoke) {
    throw new Error(
      'BunSpawnJobSpawner does not support JobContext.invoke. ' +
      'Workers that need LLM access must use JOB_SPAWNER=inproc (default). ' +
      'See spec: lobster-spawn-llm-bridge (planned).'
    )
  }
  // ...保留原 39 行 stdin write + stdout last-line 协议...
}
```

**设计原则**:
- spawn 不支持 invoke 时**显式 throw**,而不是静默退化成 invoke=undefined。前者立即可见,后者会让所有 proposal 都变成 inconclusive,排障极痛。
- spawn 模式仍可用于**未来**不需要 LLM 的 worker(例:纯 hash、纯压缩)。

### 2.3a 默认 spawner 切换

```ts
// infrastructure/jobs/index.ts
export function createJobSpawner(): JobSpawner {
  const mode = process.env.JOB_SPAWNER ?? 'inproc'   // ← 从 'spawn' 改为 'inproc'
  return mode === 'spawn' ? new BunSpawnJobSpawner() : new InprocJobSpawner()
}
```

**为什么默认切 inproc 安全**:
- 当前**仅有两个 worker**(evolution.review、memory.extract),都需要 LLM,都不能在 spawn 下工作
- 各自 `MAX_INFLIGHT=1` 节流,总并发 ≤ 2
- 都在 `subscribe('turn.completed')` 异步 handler 中跑,不阻塞当前 turn
- worker 内部是纯渲染 + 网络 IO + 字符串 parse,无 segfault 风险
- LLM provider 自带 timeout/abort,inproc 路径下用 AbortSignal + 60-120s timeout 即可

### 2.4 Host 侧:谁来构造 `JobContext`

新增一个**共享工厂**,evolution 与 memory 都从它取:

```ts
// extensions/infra-services/job-context-factory.ts
export type JobContextFactory = (opts: {
  purpose: string         // 'evolution.review.tier0' | 'evolution.review.tier2' | 'memory.extract'
  runId: string           // 该次自学习任务关联的 TraceRun id
}) => JobContext

export function createJobContextFactory(
  invoke: ProviderInvoke,
  logger: Logger,
): JobContextFactory {
  return ({ purpose, runId }) => ({
    invoke: async (req) => {
      const resp = await invoke.call({
        kind: 'internal',
        purpose,
        parentTurnId: `${purpose}:${runId}`,   // 对齐 compactor 的 `compact:<sessionId>` 模式
        messages: req.messages,
        maxTokens: req.maxTokens,
      })
      return { content: resp.content, usage: resp.usage }
    },
    log: (level, msg) => logger[level]('job', msg),
  })
}
```

> **`parentTurnId` 格式**:`<purpose>:<runId>`,与 compactor 的 `compact:${sessionId}` 对齐。trace 里 `grep 'memory.extract:'` / `grep 'evolution.review.tier0:'` 可直接捞出对应 invoke 记录,且 `:` 后缀就是触发它的 `runId`。

`infra-services` extension 在 apply 时拉 `provider.llm`,把这个 factory 通过 `provide` 暴露:

```ts
provide: {
  'job-spawner': () => spawner,
  'job-context-factory': () => createJobContextFactory(invoke, ctx.logger),
  ...
}
```

evolution / memory 拿到 factory,在每次 `spawner.run()` 前传入 `{ purpose, runId }` 实例化 ctx 即可。

---

## 3. Evolution worker 接入

### 3.1 `worker-entry.ts` 改写

```ts
import type { JobContext } from '../../application/ports/job-spawner'
import { buildPrompt } from './prompt-templates'
import { parseVerdict } from './parse-verdict'
import type { ReviewJob, ReviewResult } from './types'

export async function handle(job: ReviewJob, ctx: JobContext): Promise<ReviewResult> {
  const prompt = buildPrompt(job)
  const purpose = job.tier === 'tier0' ? 'evolution.review.tier0' : 'evolution.review.tier2'
  try {
    const { content } = await ctx.invoke({
      purpose,
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
    })
    return parseVerdict(content, job)
  } catch (err) {
    ctx.log?.('warn', `LLM invoke failed: ${String(err)}`)
    return parseVerdict('{}', job)   // 降级,outcome:'inconclusive'
  }
}
```

`parseVerdict` 已经能识别 `{ outcome, reasoning, skillProposed }`,无需改动。

### 3.2 `extensions/evolution/index.ts` 调用点

```ts
const factory = reg.has('infra-services.job-context-factory')
  ? reg.get<JobContextFactory>('infra-services.job-context-factory')
  : undefined
if (!spawner || !proposals || !statsStore || !factory) return

...

const result = await spawner.run<ReviewJob, ReviewResult>({
  entry: require.resolve('./worker-entry'),
  job,
  ctx: factory({
    purpose: tier === 'tier0' ? 'evolution.review.tier0' : 'evolution.review.tier2',
    runId,
  }),
  timeoutMs: REVIEW_TIMEOUT_MS,
})
```

### 3.3 `evolution.promote` 落盘

当前 `markAccepted(id)` 只改 db 一行 status。本 spec 把它扩成"真把 SKILL.md 写出来":

```ts
// extensions/evolution/promote-writer.ts (新)
export async function promoteToSkill(opts: {
  proposal: ProposalEntry      // 含 skillProposed
  skillsDir: string            // ctx.paths.skills.agent
}): Promise<{ filePath: string }> {
  const p = opts.proposal.skillProposed
  if (!p) throw new Error('proposal has no skillProposed payload')
  const safeName = p.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  const dir = join(opts.skillsDir, safeName)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'SKILL.md')
  const md = renderSkillMd(p)   // frontmatter: name/description/trigger; body: instructions
  await writeFile(filePath, md, 'utf8')
  return { filePath }
}
```

`rpc:'evolution.promote'` 改为:

1. `proposals.get(id)` → 取出 `skillProposed`
2. `promoteToSkill({...})` 写文件
3. `proposals.markAccepted(id, { filePath })`(扩展 markAccepted 第二参数)
4. `bus.emit(createEvent('skills.reload-requested', { reason: 'evolution.promote', source: proposalId }))`

**理由**：`KernelContext.rpc` 是 `RpcRegistry`，**没有 `call()`**——extension 间没有 in-process RPC client 通道。事件总线才是 in-process 因果链的正解。reload 失败不影响 promote 已落盘的真值（SKILL.md 已写、proposal 已 `markAccepted`），fire-and-forget 最自然。

**新增 contract**:

```ts
// application/contracts/skills-events.ts
export interface SkillsReloadRequestedV1 {
  reason: 'evolution.promote' | 'manual' | 'config-change'
  source?: string         // proposal id / config key 等
}
```

```ts
// application/contracts/events/contracted-event-map.ts
'skills.reload-requested': SkillsReloadRequestedV1
```

**skills ext 改动**：把现有 RPC handler `skills.reload` 的主体抽成内部 `doReload` 函数，新增 subscriber 监听 `skills.reload-requested` 调用同一个 `doReload()`，避免逻辑双写。

**closure 捕获**：evolution 的 RPC handler 与 `onTurnEvent` subscriber 都定义在 `apply(ctx)` 函数体内,共享同一份 closure。`bus = asContractBus(ctx.bus)` 在 apply scope 顶部,现有 subscriber 已用相同模式 emit 事件（`extensions/evolution/index.ts:131/141/146`）。promote handler 从 closure 捕获 `bus`、`proposals`、`ctx.paths.skills.agent`,无需新增机制。

> **不在 spec 内但建议**:`/evolution promote --auto` 用 skill-creator 模板进一步润色;此处直接落原始 instructions 即可。

---

## 4. Memory worker 接入

### 4.0 修补 `buildExtractPrompt` —— 真把 `job.run` 渲染进 user message

```ts
// extensions/memory/extract-prompt.ts
import type { ExtractJob } from './types'
import type { TraceRun } from '../../domain/trace/types'

const TURN_PREVIEW_CHARS = 400
const MAX_TURNS_IN_PROMPT = 20
const EXTRACT_MAX_TOKENS = 800

export function buildExtractPrompt(job: ExtractJob): {
  messages: Array<{ role: 'system' | 'user'; content: string }>
  maxTokens: number
} {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: formatRunForExtract(job.run) },
    ],
    maxTokens: EXTRACT_MAX_TOKENS,
  }
}

const SYSTEM_PROMPT = `You extract durable, reusable knowledge from a single agent conversation.

Output rules:
- One candidate per paragraph, separated by a blank line.
- Each paragraph starts with one or more #tags on its first line.
- Allowed tags: #preference #decision #fact #general (use the most specific).
- The body (everything after the tags) is the knowledge sentence — make it self-contained and re-readable months later.
- Drop trivia: greetings, one-off file paths, project-specific minutiae the next session won't reuse.
- If nothing durable, output exactly: NONE

Example:
#preference #tools
User prefers ripgrep over grep for code search and asks for case-insensitive matches by default.

#decision #architecture
Adopt SQLite (bun:sqlite) as the default persistence layer across session/trace/evolution/memory stores; in-memory variants removed.`

function formatRunForExtract(run: TraceRun): string {
  const head = [
    `Run ${run.id}  session=${run.sessionId}  model=${run.model}`,
    `turns=${run.summary.totalTurns}  tools=${run.summary.totalToolCalls}  errors=${run.summary.totalErrors}  outcome=${run.summary.outcome}`,
    '',
  ]
  const turns = run.turns.slice(-MAX_TURNS_IN_PROMPT)
  const body: string[] = []
  for (const t of turns) {
    body.push(`--- Turn ${t.turnIndex} ---`)
    if (t.userMessage) body.push(`User: ${t.userMessage.slice(0, TURN_PREVIEW_CHARS)}`)
    if (t.modelResponse?.text) body.push(`Agent: ${t.modelResponse.text.slice(0, TURN_PREVIEW_CHARS)}`)
    const tools = t.modelResponse?.toolCalls.map(c => c.name).join(', ')
    if (tools) body.push(`Tools: ${tools}`)
  }
  return head.concat(body, '', 'Extract knowledge from the above conversation following the output rules.').join('\n')
}
```

**注意点**:
1. **`MAX_TURNS_IN_PROMPT = 20`**:policy 是每 5 turn 触发一次,只看最近 20 轮足够覆盖,且天然规避"老 turn 被反复抽出同样的 candidate"。
2. **`NONE` 哨兵**:`parseCandidates("NONE")` 自然返回 `[]`(因为没有 `#tag` 行),不需要额外分支。
3. **不复用 evolution 的 `formatRun`**:那个 helper 偏审计风格(成功率、耗时、错误信息);memory 抽取需要的是"对话文本",字段集不一样,各自维护更清晰。

### 4.1 `extract-worker.ts` 改写

```ts
import type { JobContext } from '../../application/ports/job-spawner'
import { buildExtractPrompt } from './extract-prompt'
import type { ExtractJob, ExtractResult, MemoryCandidate } from './types'

const DEFAULT_WEIGHT = 1

export async function handle(job: ExtractJob, ctx: JobContext): Promise<ExtractResult> {
  const prompt = buildExtractPrompt(job)
  try {
    const { content } = await ctx.invoke({
      purpose: 'memory.extract',
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
    })
    return { candidates: parseCandidates(content) }
  } catch (err) {
    ctx.log?.('warn', `LLM invoke failed: ${String(err)}`)
    return { candidates: [] }
  }
}

/** Parses `#tag1 #tag2\nbody` paragraphs into candidates. */
export function parseCandidates(raw: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = []
  const blocks = raw.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n')
    const first = lines[0]!
    const tagMatches = [...first.matchAll(/#([a-z][a-z0-9-]*)/gi)].map(m => m[1]!.toLowerCase())
    if (tagMatches.length === 0) continue          // 没 tag 就丢
    const bodyLines = first.replace(/#[a-z][a-z0-9-]*/gi, '').trim()
      ? [first.replace(/#[a-z][a-z0-9-]*/gi, '').trim(), ...lines.slice(1)]
      : lines.slice(1)
    const text = bodyLines.join('\n').trim()
    if (!text) continue
    out.push({ text, weight: DEFAULT_WEIGHT, tags: tagMatches })
  }
  return out
}
```

### 4.2 `memory/index.ts` 调用点

```ts
const factory = ctx.extensions.has('infra-services.job-context-factory')
  ? ctx.extensions.get<JobContextFactory>('infra-services.job-context-factory')
  : undefined
if (!spawner || !factory) return

...

const result = await spawner.run<ExtractJob, ExtractResult>({
  entry: require.resolve('./extract-worker'),
  job: { runId: e.runId, run },
  ctx: factory({ purpose: 'memory.extract', runId: e.runId }),
  timeoutMs: EXTRACT_TIMEOUT_MS,
})
```

### 4.3 写入侧最小正确性

`memory/index.ts` 现在写入时 `type: 'general'` 写死,且无去重。本 spec 把它改成:

**1. Port 增 1 个方法**（`MemoryStore` 接口）:

```ts
// application/ports/memory-store.ts
/** Exact-match dedupe check: same text AND same type. NOT semantic similarity. */
hasExactDuplicate(args: { text: string; type: MemoryEntry['type'] }): Promise<boolean>
```

**2. SQLite migration**（memory schema v1 增量）:

```sql
CREATE INDEX IF NOT EXISTS idx_memory_type_text ON memory(type, text);
```

**3. `SqliteMemoryStore` 实现** — prepared statement 走上述索引:

```ts
// infrastructure/memory/sqlite-memory-store.ts
private existsSimilarStmt = this.db.prepare(
  'SELECT 1 FROM memory WHERE type = ? AND text = ? LIMIT 1'
)

async hasExactDuplicate({ text, type }: { text: string; type: MemoryEntry['type'] }): Promise<boolean> {
  return !!this.existsSimilarStmt.get(type, text)
}
```

**4. `memory/index.ts` 调用处**:

```ts
for (const c of result.candidates) {
  const type = inferType(c.tags)
  if (await store.hasExactDuplicate({ text: c.text, type })) continue
  await store.add({
    type, text: c.text, weight: c.weight, source: 'implicit',
    tags: c.tags, usageCount: 0,
  })
}

function inferType(tags: string[]): MemoryType {
  if (tags.includes('preference') || tags.includes('pref')) return 'preference'
  if (tags.includes('decision')) return 'decision'
  if (tags.includes('fact')) return 'fact'
  return 'general'
}
```

**命名理由**:`hasExactDuplicate` 明确表示"字面 + type 完全相同",给未来语义级 `findSimilar(text, threshold)`（`lobster-memory-lifecycle` spec）留出语义空间,避免新旧方法名只差返回类型造成误用。

**性能**:索引 `(type, text)` 命中,O(log n) 查找。如未来 text 长度普遍 > 2KB 影响索引高度,可在后续 spec 加 `text_hash` 列。

> 注:语义级去重(embedding 距离 < 阈值)留给"记忆生命周期" spec。本 spec 只做"完全相同字面 + 同 type 不重复入库"。

---

## 5. 数据流总览

```
turn.completed
   │
   ├── evolution.subscribe('turn.completed')   ──→ policy → tier0/tier2 decision
   │                                                  │
   │                                                  ▼
   │                                      spawner.run({entry, job, ctx})
   │                                                  │
   │                                       child stdout ── invoke-req ──→ host invoke (provider.llm)
   │                                       child stdin  ← invoke-resp ─── host
   │                                                  │        parentTurnId = `${purpose}:${runId}`
   │                                       parseVerdict(content)
   │                                                  │
   │                                       proposals.append + statsStore.bump
   │                                                  │
   │                                       (user runs /evolution promote <id>)
   │                                                  │
   │                                       promoteToSkill → SKILL.md → skills.reload
   │
   └── memory.subscribe('turn.completed')      ──→ policy(tokens ≥ 800 or 5-turn)
                                                      │
                                                      ▼
                                      spawner.run({entry, job, ctx})
                                                      │
                                          (同上 invoke-req / resp 桥)
                                                      │
                                          parseCandidates(content)
                                                      │
                                          inferType + existsSimilar 去重
                                                      │
                                          memory_entries.insert
                                                      │
                                          下一轮 transformPrompt 召回 ── <retrieved_memory> ── 注入 system
```

---

## 6. 已知遗留(本 spec 不做,留 follow-up)

| 项 | 留给哪个 spec |
|---|---|
| 语义级 `findSimilar(text, threshold)` | `lobster-memory-lifecycle` |
| `text_hash` 列优化超长 text 的索引 | `lobster-memory-lifecycle` |
| memory 衰减 + usage_count 召回 bump | `lobster-memory-lifecycle` |
| 矛盾合并("用户喜欢 X" vs "用户不喜欢 X") | `lobster-memory-lifecycle` |
| evolution Tier2 自动 retire(stats 太差自动 markRejected) | `lobster-evolution-autoretire` |
| `memory.remember` tool(agent 显式写) | `lobster-memory-explicit-write` |
| Bun.spawn 真实跨进程 invoke 的 SIGTERM/超时一致性 | 实现期回归 |
| Spawn 子进程的 LLM 双向 RPC 桥(stdin/stdout JSON-line 协议) | `lobster-spawn-llm-bridge` |
| Worker thread 形态的真隔离(替代 spawn 半吊子隔离) | `lobster-spawn-llm-bridge` |
| in-flight 队列持久化(重启续跑) | 不计划做,失败重试就行 |

---

## 7. 实施分步(单 PR,6 commits)

| # | Commit | 说明 |
|---|---|---|
| 1 | `feat(jobs): JobContext + Spawner protocol upgrade, default to inproc` | port 升级;inproc 实现完整传 ctx;spawn 实现遇到 invoke ctx 显式 throw;`createJobSpawner` 默认改 inproc |
| 2 | `feat(infra-services): job-context-factory + provider.llm wiring` | 注册 factory 到 extension registry |
| 3 | `feat(evolution): wire LLM invoke in worker-entry` | worker 用 ctx.invoke;index.ts 拿 factory |
| **4a** | **`fix(memory): buildExtractPrompt actually renders TraceRun`** | **prompt 接 `job.run` + `formatRunForExtract` + `NONE` 哨兵 + 单测** |
| **4b** | `feat(memory): wire LLM invoke + parseCandidates` | worker 用 ctx.invoke + parseCandidates 实现 + 单测 |
| 5 | `feat(memory): hasExactDuplicate + inferType` | port 加 1 方法;SqliteMemoryStore 实现 + (type,text) 索引 migration;index.ts 去重逻辑;单测覆盖 |
| 6 | `feat(evolution): promote → SKILL.md + skills.reload-requested event` | promote-writer.ts + rpc 升级;evolution emit `skills.reload-requested`;skills ext 抽 `doReload` 函数并新增 subscriber;新增 `SkillsReloadRequestedV1` contract |

---

## 8. 测试矩阵

### 8.1 单元
- `buildExtractPrompt`:给一个 3-turn 的 mock TraceRun → user message 必须包含每个 `User:` / `Agent:` 行
- `buildExtractPrompt`:给一个 30-turn 的 mock TraceRun → user message 只渲染最后 20 个 turnIndex
- `parseCandidates`:多 tag、空 body、缺 tag、Windows 换行,各一例
- `inferType`:tag 优先级、未知 tag 落 general
- `promoteToSkill`:文件路径转义、frontmatter 正确性
- `hasExactDuplicate`:返回 false（库空）
- `hasExactDuplicate`:返回 true（同 type 同 text）
- `hasExactDuplicate`:返回 false（同 text 但不同 type）

### 8.2 集成(inproc spawner)
- evolution:E2E 一个 mock turn → 看 `proposals` 表有 1 行非 inconclusive
- memory:E2E 一个 mock turn(usage.input + output ≥ 800)→ 看 `memory_entries` 表有 ≥1 行 implicit
- memory 去重:同一 text 跑两次 → 表里只有 1 行

### 8.3 Spawn 模式 fail-fast 测试
- 强制 `JOB_SPAWNER=spawn` 跑 evolution worker,期望 **spawner.run() 立即 throw**,错误信息包含 `'JOB_SPAWNER=inproc'`
- 错误信息包含 `'lobster-spawn-llm-bridge'` 指向 follow-up spec

### 8.4 退化路径
- provider 返回非 JSON → evolution.outcome 应为 inconclusive,memory.candidates 应为 []
- provider 抛错 → 同上,且 `memory.extract.failed` / `evolution.review.failed` 事件被 emit

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 有人误开 `JOB_SPAWNER=spawn`,所有 self-learning 失效 | spawn 路径在收到 invoke ctx 时 **fail-fast throw**,错误信息直接指向解决方法。绝不静默退化 |
| RPC handler 与 subscriber 拿到的 ctx 不一致 | 不存在此风险:两者都是 `apply(ctx)` 同一调用栈内 closure 捕获,现有 evolution 代码已验证此模式（`onTurnEvent` 与 `evolution.listProposals` RPC 共享同一 `proposals` 引用） |
| Inproc 路径下 LLM 调用阻塞同 turn? | 不会:跑在 `turn.completed` 之后的 async handler,`MAX_INFLIGHT=1`。turn 提交早已 finalize |
| 未来需要真隔离 worker(不可信代码) | 留给 `lobster-spawn-llm-bridge` 或 Worker thread spec,本 spec 不预先承诺 |
| `parentTurnId` 不是 ULID 格式,下游若有 strict 解析会拒收 | 现状已经有 `compact:<sessionId>` / `bootstrap-<ts>` 在线,trace 端早就接受非 ULID 字符串;此举对齐既有模式,无新增风险 |
| LLM 不按 prompt 输出 JSON / `#tag` 格式 | `parseVerdict` / `parseCandidates` 已经设计成"解析失败就降级",不会抛 |
| 长 turn 把 prompt 撑爆,模型截断后置内容 | `MAX_TURNS_IN_PROMPT=20` + `TURN_PREVIEW_CHARS=400` 双限;按 800 maxTokens output 估算,user message ≤ ~16KB,Claude/OpenAI 都吃得下 |
| memory 写入回环(LLM 输出包含历史 memory 文本,被再次抽出) | `existsSimilar` 已挡;后续语义去重 spec 再加固 |
| `evolution.promote` 写文件失败(权限/磁盘满) | rpc 抛错回 CLI,proposals 保持 pending 状态(markAccepted 不动) |
| 跨 PR 协议变更影响测试 | commit 1 用"两段签名都允许"过渡,commit 7 才收紧 |

---

## 10. 验收 checklist

- [ ] `JobSpawner.run` 接受 `ctx`,inproc 和 spawn 两种实现都 pass
- [ ] evolution worker E2E 至少产生一条 `outcome:'accepted'` 的 proposal(用 mock provider 强返 accept JSON)
- [ ] memory worker E2E 至少产生一条 `memory_entries` 行(同上,mock provider 返 `#fact\nbody`)
- [ ] `/evolution promote <id>` 后,bus 上能观察到 `skills.reload-requested{reason:'evolution.promote',source:<proposalId>}` → 紧跟 `skills.reloaded{added:1,...}`,且 `/skills list` 包含新 skill
- [ ] 同一 text + type 跑 2 次,memory 表只 1 行
- [ ] provider 抛错时,两个 worker 都不抛 unhandled rejection,且 emit `*.failed` 事件
- [ ] `JOB_SPAWNER=spawn bun test self-learning-*.test.ts` → spawner.run() 抛错,错误信息中包含 `'JOB_SPAWNER=inproc'` 和 `'lobster-spawn-llm-bridge'`
- [ ] trace 里能 `grep 'memory.extract:'` / `grep 'evolution.review.tier0:'` 直接捞出对应 invoke 记录,且 `:` 后缀就是触发它的 `runId`
- [ ] knip / lint / typecheck / bun test 全绿

---

## 11. 与已落成果的关系

- `2658900 /clear` + `53cdc1f session slash` → 修了"用户能开始/清除会话"
- SQLite 持久化栈(`7e2fa03` → `500ffad`)→ 修了"proposals / memory 写得进去"
- **本 spec** → 修"写进去的是 LLM 真的判断/抽取出来的内容",闭合"自学习"环

完成后,agent 才第一次真正满足:
> 跑一段时间 → 自动沉淀新 skill、自动积累用户偏好 → 下一轮看得到、用得上
