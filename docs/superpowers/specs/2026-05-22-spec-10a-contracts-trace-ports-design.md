# Spec P-10: Evolution / Memory / Trace / MCP 重构 + 同名嵌套全仓清退

## TL;DR

删除 nudge ext 设计，evolution/memory 改为"订阅 contract events + fork worker"的轻量模式。memory 同时实装 hybrid retriever（keyword + BM25 + vector + RRF）。trace ext 合并旧端口为 TraceCheckpointer。全仓 6 处 `<x>/<x>/` 同名嵌套目录清退。分 3 个独立 spec/session 执行。

---

## 0. 已锁定决策（grill-me 产出）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 交付拆分 | 3 个独立 session：Spec-10a（契约层 + trace + ports）、Spec-10b（同名嵌套清退 + evolution/memory 重写）、Spec-10c（identity 接管 + 架构守卫升级） |
| D2 | nudge ext | **撤掉**，evolution/memory 各维 `internal/policy.ts`，直接订阅 `turn.completed` + `turn.failed` |
| D3 | trace 端口 | 删 `trace-store.ts` + `trace-writer.ts`，合并为 `trace-checkpointer.ts`；onTraceEmit hook 保留，`trace.flushed` 字面量 emit 删除 |
| D4 | R-EXT-1 | **平铺**，所有 ext 私有模块放 `extensions/<x>/` 根下；测试统一放根目录 `tests/` |
| D5 | MCP 类型 | outer `types.ts` 为零消费死代码，直接删；inner types 随目录平铺，无破坏面 |
| D6 | frontend.lark + A14 | LarkBotAdapter（320 行）整体搬家到 `internal/lark-bot-adapter.ts`，不拆内部职责；A14 在 Phase G 准时升 fail |
| D7 | TurnCompletedV1 | `outcome` 只放 `turn.failed`；`runId = turnId`；`activatedSkills` 首版空数组；修重复 emit bug + 吞事件 bug |
| D8 | codemod | 不写脚本，换 rg 验收门 + Phase E/F 行级工作清单 |
| D9 | adapter 删除 | 职责重分配：类型翻译下沉 store、路径策略上移 infra 工厂、port 扩 5 方法（ftsSearch/vectorSearch/storeEmbedding/entriesWithoutEmbeddings/markHit） |
| D10 | job spawner | `Bun.spawn` + stdin/stdout NDJSON 生产，inproc 兜底，`JOB_SPAWNER` env var 切换；`child_process.fork` 砍掉 |
| D11 | store 摸底 | FTS5 + BM25 + sqlite-vec + markHit 全部已实现，store promote 改造量约 30 行 |
| D12 | A10 违规 | sqlite-memory-adapter.ts 是 infra 下唯一从 ext 内部 import 的文件，删掉即清零 |
| D13 | Phase E+F | 合并为一个 session 并行执行 |

---

## 1. ContractedEventMap 增量

### 1.1 事件新增

```ts
// evolution 事件
export interface EvolutionReviewStartedV1   { runId: string; tier: 'tier0' | 'tier2'; skillName?: string }
export interface EvolutionReviewCompletedV1 { runId: string; tier: 'tier0' | 'tier2'; outcome: 'accepted' | 'rejected' | 'inconclusive'; skillName?: string }
export interface EvolutionReviewFailedV1    { runId: string; tier: 'tier0' | 'tier2'; message: string }

// memory 事件
export interface MemoryExtractStartedV1   { runId: string }
export interface MemoryExtractCompletedV1 { runId: string; count: number }
export interface MemoryExtractFailedV1    { runId: string; message: string }

// MCP 事件
export interface McpServerConnectedV1    { name: string; capabilities: McpCapabilitiesSummary }
export interface McpServerDisconnectedV1 { name: string; reason: 'shutdown' | 'error' | 'removed' }
export interface McpServerFailedV1       { name: string; message: string; attempt: number }
export interface McpReloadedV1           { reconnected: string[]; failed: string[] }
export interface McpToolsChangedV1       { added: string[]; removed: string[]; serverName: string }
```

### 1.2 TurnCompletedV1 扩展

```ts
export interface TurnCompletedV1 {
  sessionId: string
  turnId: string
  runId: string            // 新增，= turnId
  usage: { input: number; output: number }  // 改为必填
  toolCallCount: number     // 新增
  toolErrorCount: number    // 新增
  activatedSkills: string[] // 新增，首版空数组
}
```

### 1.3 TurnFailedV1 扩展

```ts
export interface TurnFailedV1 {
  sessionId: string
  turnId: string
  runId: string             // 新增
  outcome: 'error' | 'aborted' | 'max_turns' | 'network_error'
  stage: string
  reason: string
  toolErrorCount: number    // 新增
}
```

### 1.4 删除

- `memory.summary.ready` / `memory.summarized` 标记 deprecated，Phase F 物理删除

---

## 2. 端口新增/整合

### 2.1 trace-checkpointer.ts（整合 trace-store.ts + trace-writer.ts）

```ts
import type { TraceEvent } from '../../domain/trace-event'
import type { TraceRun, TraceSummary } from '../../domain/trace/types'

export interface TraceCheckpointer {
  append(event: TraceEvent): Promise<void>
  flush(): Promise<void>
  getRun(runId: string): Promise<TraceRun | null>
  listRecentSummaries(opts: { limit: number; sessionId?: string; since?: number }): Promise<TraceSummary[]>
}

export type TraceReader = Pick<TraceCheckpointer, 'getRun' | 'listRecentSummaries'>
```

### 2.2 job-spawner.ts

```ts
export interface JobSpawner {
  run<TJob, TResult>(opts: {
    entry: string         // require.resolve(...) 绝对路径
    job: TJob             // JSON-safe
    timeoutMs?: number
  }): Promise<TResult>    // JSON-safe
}
```

### 2.3 proposal-store.ts + skill-stats-store.ts

```ts
export interface ProposalStore {
  append(proposal: ProposalRecord): Promise<void>
  list(opts?: { limit?: number }): Promise<ProposalRecord[]>
  markAccepted(id: string): Promise<void>
  markRejected(id: string): Promise<void>
}

export interface SkillStatsStore {
  get(skillName: string): Promise<SkillStats | null>
  put(stats: SkillStats): Promise<void>
  bump(skillName: string, outcome: 'accepted' | 'rejected' | 'inconclusive'): Promise<void>
  list(): Promise<SkillStats[]>
}
```

### 2.4 memory-store.ts 扩展

在现有 port 基础上新增：

```ts
ftsSearch(query: string, limit: number): Promise<MemoryEntry[]>
vectorSearch(queryEmbedding: number[], limit: number): Promise<Array<{ entry: MemoryEntry; distance: number }>>
storeEmbedding(entryId: string, embedding: number[]): Promise<void>
entriesWithoutEmbeddings(batchSize: number): Promise<Array<{ id: string; text: string }>>
markHit(ids: string[]): Promise<void>
clear(): Promise<void>
```

---

## 3. trace ext 改造

```ts
// extensions/trace/index.ts（目标 ~40 行）
export default (opts?: { baseDir?: string }) => defineExtension({
  name: 'trace', enforce: 'pre',
  apply: (ctx) => {
    const baseDir = opts?.baseDir ?? defaultTraceDir(ctx.profileId)
    const checkpointer = createNdjsonCheckpointer(baseDir, ctx.profileId)

    const onTraceEmit: HookHandler = async (...args) => {
      await checkpointer.append(args[0] as TraceEvent)
      // 不再 bus.emit('trace.flushed', ...)
    }
    return {
      provide: { reader: () => checkpointer as TraceReader },
      hooks: {
        onTraceEmit: { enforce: 'pre', fn: onTraceEmit },
        onShutdown:  { enforce: 'post', fn: async () => { await checkpointer.flush() } },
      },
      dispose: () => checkpointer.flush(),
    }
  },
})
```

**清理清单**：
| 动作 | 文件 | 原因 |
|---|---|---|
| 删除 `trace.flushed` emit | `extensions/trace/index.ts` | A9 违反 |
| 删除 `trace.flushed` 订阅 | `extensions/evolution/index.ts` + `extensions/memory/index.ts` | 改订 contract events |
| 删除 `trace.flushed` 类型 | `domain/trace-event.ts` | 已无产出/消费方 |

---

## 4. evolution ext 重构

### 4.1 目标结构（平铺 9 文件）

```
extensions/evolution/
├── index.ts              # ext 工厂（~120 行）
├── policy.ts             # tier0 / tier2 / skip 决策
├── prompt-templates.ts   # 字面量迁移
├── parse-verdict.ts      # LLM 文本 → 结构化
├── worker-entry.ts       # 子进程入口 + handle 函数
├── skill-stats.ts        # 父进程成功率统计
├── proposal-writer.ts    # worker 结果写入 ProposalStore
└── types.ts              # ReviewJob / ReviewResult / Tier / Decision
                          # 测试放 tests/extensions/evolution/
```

### 4.2 文件清理（20 → 8）

| 旧文件 | 处置 |
|---|---|
| `evolution/index.ts`（182 行） | 重写 |
| `evolution/evolution-core.ts` | 删 |
| `evolution/evolution/**`（18 文件，2276 行） | 全删 |
| 净效果：~2500 行 → ~700 行 |

### 4.3 policy.ts

```ts
import type { TurnCompletedV1, TurnFailedV1 } from '../../application/contracts/session-events'

const MIN_TURNS_BETWEEN_REVIEWS = 10
const ERROR_BURST_THRESHOLD = 3
const ERROR_BURST_WINDOW_MS = 5 * 60_000
const SKILL_REVIEW_INTERVAL_RUNS = 20

export type Decision = { kind: 'skip' } | { kind: 'tier0' } | { kind: 'tier2'; skillName: string }

export interface PolicyState {
  turnsSinceReview: number
  errorBurst: number[]
  inflight: number
  skillRunsSeen: Record<string, number>
}

export function evaluateReviewPolicy(
  event: TurnCompletedV1 | TurnFailedV1,
  s: PolicyState,
): Decision {
  s.turnsSinceReview++

  if ('outcome' in event && event.outcome !== 'completed') {
    s.errorBurst.push(Date.now())
    s.errorBurst = s.errorBurst.filter(t => Date.now() - t < ERROR_BURST_WINDOW_MS)
    if (s.errorBurst.length >= ERROR_BURST_THRESHOLD) {
      s.errorBurst = []; s.turnsSinceReview = 0
      return { kind: 'tier0' }
    }
    return { kind: 'skip' }
  }

  for (const skill of (event as TurnCompletedV1).activatedSkills ?? []) {
    s.skillRunsSeen[skill] = (s.skillRunsSeen[skill] ?? 0) + 1
    if (s.skillRunsSeen[skill] >= SKILL_REVIEW_INTERVAL_RUNS) {
      s.skillRunsSeen[skill] = 0
      return { kind: 'tier2', skillName: skill }
    }
  }

  if (s.turnsSinceReview >= MIN_TURNS_BETWEEN_REVIEWS) {
    s.turnsSinceReview = 0
    return { kind: 'tier0' }
  }

  return { kind: 'skip' }
}
```

### 4.4 worker-entry.ts

```ts
export async function handle(job: ReviewJob): Promise<ReviewResult> {
  const provider = createProviderInvoke()
  const prompt = buildPrompt(job)
  const resp = await provider.call({ ... })
  return parseVerdict(resp.content, job)
}

// 自启动入口
if (process.env.JOB_MODE === 'spawn') {
  const stdin = await new Response(Bun.stdin).text()
  const job = JSON.parse(stdin.trim().split('\n')[0]!)
  handle(job)
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0) })
    .catch(e => { process.stderr.write(String(e) + '\n'); process.exit(1) })
}
```

---

## 5. memory ext 重构

### 5.1 目标结构（平铺 9 文件）

```
extensions/memory/
├── index.ts              # ext 工厂（~140 行）
├── policy.ts             # extract 触发判定
├── extract-prompt.ts     # LLM prompt
├── extract-worker.ts     # 子进程入口 + handle
├── retrievers.ts         # Keyword + BM25 + Vector + Hybrid (RRF)
├── embedding-encoder.ts  # Ollama / Fake encoder
├── embedding-backfill.ts # 后台补 embedding
├── recall.ts             # createRecall(store, encoder, weights) → RecallAPI
├── types.ts              # ExtractJob / ExtractResult / RetrieverWeights
```

### 5.2 文件清理（13 → 9 + infra 上提）

| 旧文件 | 处置 |
|---|---|
| `memory/index.ts`（97 行） | 重写 |
| `memory/memory/agent-md.ts` | 删（identity capability 接管） |
| `memory/memory/sqlite-store.ts` | 上提 → `infrastructure/memory/sqlite-memory-store.ts` |
| `memory/memory/sqlite-schema.ts` | 上提 → `infrastructure/memory/sqlite-schema.ts` |
| `infrastructure/memory/sqlite-memory-adapter.ts` | 删（反模式包装层） |
| `memory/memory/retriever.ts` + bm25 + vector + hybrid | 重写合入 `retrievers.ts` |
| `memory/memory/embedding-runner.ts` | 重写 → `embedding-backfill.ts` |
| `memory/memory/recall.ts` | 重写 → `recall.ts` + `extract-worker.ts` |
| `memory/memory/types.ts` | 拆：domain types 上提 domain/，ext 私有进 `types.ts` |

净效果：~1160 行（含 adapter）→ ~700 行（ext）+ 上提至 infra 的 store

### 5.3 retrievers.ts 架构

```
KeywordRetriever    — LIKE + 5维加权打分
Bm25Retriever       — FTS5 + BM25 ranking
VectorRetriever     — sqlite-vec 余弦距离（encoder 不可用时静默降级）
HybridRetriever     — RRF(k=60) 融合三路，weights 可配 {vector:0.5, bm25:0.3, keyword:0.2}
```

### 5.4 transformPrompt 去向

memory ext **不再注册 transformPrompt 钩子**。recall 注入由 identity capability 主动调用：

```ts
const recall = ctx.extensions.get('memory.recall')
const memories = await recall.search(latestUserMessage, { limit: 5 })
```

---

## 6. MCP ext 改造

### 6.1 目标结构（平铺）

```
extensions/mcp/
├── index.ts
├── types.ts              # 单一类型源（来自 mcp/mcp/types.ts）
├── manager.ts
├── tool-adapter.ts
├── prompt-registry.ts
├── server-persistence.ts
├── server-listers.ts
├── tools.ts
├── rpc.ts
```

### 6.2 改动

- 删除 `extensions/mcp/types.ts`（44 行死代码，0 消费点）
- `mcp/mcp/**` 7 文件平铺到 `mcp/`，import 路径不变（同目录搬）
- `mcp/index.ts` 改 6 处 import：`./mcp/X` → `./X`
- MCP 事件接入 ContractedEventMap（见 §1.1）

---

## 7. skills ext 改造

```
extensions/skills/
├── index.ts
├── agent-legacy.ts       # 保留
├── loader.ts             # from skills/skills/loader.ts
├── middleware.ts          # from skills/skills/middleware.ts
├── registry.ts            # from skills/skills/index.ts（用具名导出）
```

### 7.2 改动

- 删 `skills/skills/` 3 文件（迁移入平铺）
- `skills/skills/index.ts` barrel 角色由 ext `index.ts` 具名 import 替代

---

## 8. frontend.lark ext 改造

```
extensions/frontend.lark/
├── index.ts               # ~122 行（仅配置 + ext 装配）
├── lark-bot-adapter.ts    # LarkBotAdapter 类（320 行，从 index.ts 搬出）
└── internal/
    ├── client.ts          # from lark/client.ts
    ├── message-parser.ts  # from lark/message-parser.ts
    ├── event-dispatcher.ts
    ├── card-builder.ts
    ├── card-handler.ts
    └── types.ts
```

B2 方案：LarkBotAdapter 类整体搬家，不拆内部 7 职责。

---

## 9. 域 / infrastructure 增量

```
domain/
├── skill-stats.ts
└── evolution-proposal.ts

infrastructure/
├── trace/
│   ├── ndjson-checkpointer.ts   # rename fs-trace-writer
│   ├── inmem-checkpointer.ts    # rename inmem-trace-writer
│   └── sqlite-checkpointer.ts   # 占位
├── memory/
│   ├── sqlite-memory-store.ts   # promote from extensions/memory/memory/
│   ├── sqlite-schema.ts
│   └── index.ts                 # createSqliteMemoryStore 工厂
├── evolution/
│   ├── fs-proposal-store.ts
│   └── fs-skill-stats-store.ts
└── jobs/
    ├── bun-spawn-job-spawner.ts
    ├── inproc-job-spawner.ts
    └── index.ts                 # createJobSpawner 工厂
```

---

## 10. 架构守卫

| ID | 规则 | 上线 |
|---|---|---|
| A9 | bus.emit 事件名必须在 ContractedEventMap | Phase C |
| A10 | ext 间禁止订阅他 ext expose 内部状态 | Phase C |
| A11 | trace ext 只 expose `trace.reader` | Phase C |
| **A12** | `src/extensions/<x>/` 下禁止任何子目录 | Phase E/F |
| A13 | `extensions/memory/**` 禁止 import identity 或 `agent[-_]?md` | Phase G |
| **A14** | ext `index.ts` ≤ 150 行（warn → fail） | Phase H |
| A15 | `extensions/<x>/*.ts` 符号禁止被 `extensions/<y>/**`（y≠x）直接 import | Phase E |
| A16 | 同名 type/interface 禁止跨 domain/ports/exts 重复定义 | Phase C |
| **A17** | worker-entry.ts 必须导出 `handle(job)` 函数 | Phase E |

---

## 11. 分 Phase 执行

### Spec-10a：契约层 + trace + ports

| Phase | 内容 |
|---|---|
| **A** | domain 增量：`skill-stats.ts`、`evolution-proposal.ts`；ports 增量：`trace-checkpointer.ts`（整合）、`job-spawner.ts`、`proposal-store.ts`、`skill-stats-store.ts`、`memory-store.ts` 扩展；ContractedEventMap 加 11 事件 + 扩展 TurnCompletedV1/TurnFailedV1；turn-runner 修重复 emit bug + 吞事件 bug |
| **B** | infrastructure 增量：`ndjson-checkpointer.ts`、`inmem-checkpointer.ts`、`bun-spawn-job-spawner.ts`、`inproc-job-spawner.ts`、`fs-proposal-store.ts`、`fs-skill-stats-store.ts`；store promote：`sqlite-memory-store.ts` + `sqlite-schema.ts` 从 ext 上提并改造（类型翻译下沉、新增 clear/close 幂等、threshold 下推）；Bun spawn 烟雾测试 |
| **C** | trace ext 切 checkpointer；删 `trace.flushed` emit/subscribe；删旧 `trace-store.ts` + `trace-writer.ts`；A9/A10/A11/A16 上线 |

验收：类型编译通过；`grep trace.flushed src/` 零命中；port 契约测试通过

### Spec-10b：同名嵌套清退 + evolution/memory 重写

| Phase | 内容 |
|---|---|
| **D** | MCP ext 平铺：删 outer `types.ts`（死代码），`mcp/mcp/**` 7 文件 → `mcp/`；MCP 事件接入 contract |
| **E+F** | evolution 重构（删 20 文件，新建 8 文件）+ memory 重构（删 13 文件 + adapter，新建 9 文件）+ skills 平铺 + frontend.lark 平铺（含 B2）+ trace/trace/ 删除；A12/A15/A17 上线 |

验收：A12 全仓零命中；evolution.review.* + memory.extract.* 事件可触发；hybrid recall RRF 融合三路；backfill 30s 内补齐 embedding

### Spec-10c：identity 接管 + 守卫升级

| Phase | 内容 |
|---|---|
| **G** | identity capability 接管 transformPrompt：移除 memory ext 的 transformPrompt 钩子；identity 主动调 `memory.recall`；A13 上线 |
| **H** | A14 行数守卫升 fail；确认所有 ext index.ts ≤ 150 行 |

---

## 12. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| TurnCompletedV1/TurnFailedV1 扩展触发 turn-runner 重写 + 多处 emit 点同步 | 中 | Phase A 单 PR 集中改；新字段全部 optional |
| Bun.spawn IPC 行为差异 | 中 | inproc-job-spawner 兜底；CI 同时跑 spawn + inproc |
| Ollama 未运行 → encode 全部失败 | 中 | encoder 静默 reject；首次启动连通性检测失败则禁用 backfill |
| MemoryEntry domain(Date) vs store(ISO) 类型落差 | 高 | store promote 时内置转换，port 出入全 Date |
| Phase E/F 大面积文件删除 + 新建 | 中 | Phase A 末尾 rg 验收门确认破坏面无漂移 |
| sqlite-vec 在 CI/某些平台编译失败 | 低 | configureSqlite() 已有 fallback；vectorSearch 抛错时 hybrid 降级 |

---

## 13. rg 验收门（Phase A 末尾执行）

```bash
# 确认生产代码破坏面仅 sqlite-memory-adapter 一处
rg -n "extensions/(evolution|memory|mcp)/(evolution|memory|mcp)/" src/
```
