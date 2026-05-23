# Spec P-9: Trace / Memory / Evolution / Skills 重构

## TL;DR

不是清理死代码，而是用当前 kernel 架构（extensions + hooks + contracts + ports + defineTool）**重新实现**这四个子系统的原始设计意图。每个子系统保留其核心功能，但适配到 kernel 模式：capability 通过 `provide` + `ctx.extensions.get()` 暴露，副作用通过 contractBus 事件 + hooks 驱动，tools 用 `defineTool` 重建。

---

## Track A: Trace — 轻量修复

trace 是四者中最健康的，只需微调。

### A.1 删除孤立 types 文件

`trace/trace/types.ts`（41 行）——`TraceEntry`、`TraceRedactor`、`NudgeState`、`NudgeResult`、`TraceStore` 全零引用。删除。

### A.2 修复 dispose 行为

当前 `dispose()` 调 `store.clear()` 销毁全部 trace 数据。改为 `store.flush()`（仅刷盘，不清空）。

### A.3 trace.writer / trace.reader 能力保留

这两个 capability 虽然当前无消费者，但保留——它们是 trace 的对外接口，后续 controlplane 可通过 `ctx.extensions.get('trace.writer')` 读取 trace 数据。

---

## Track B: Memory — 按 kernel 模式重建

目标：实现原始 memory design spec 中的三个功能——
1. **memory tool**（agent 主动读写记忆：search / add / list / forget）
2. **自动注入**（`transformPrompt` hook 注入相关记忆到 system prompt）
3. **自动提取**（`onTurnEnd` hook 触发 LLM 提取对话知识）

### B.1 端口整理

保持 `application/ports/memory-store.ts` 中的 `MemoryStore` 接口。新增 `application/ports/memory-retriever.ts`：

```ts
export interface MemoryRetriever {
  search(query: string, options?: { limit?: number }): Promise<MemoryEntry[]>;
}
```

### B.2 基础设施：SqliteMemoryAdapter

`infrastructure/memory/sqlite-memory-adapter.ts` 已存在，实现 `MemoryStore` 端口。修复其 cross-layer import（当前从 `extensions/memory/memory/` import SqliteMemoryStore）。

改为：SqliteMemoryAdapter 直接在内部实现 SQLite 操作，不再依赖 extension 内部类。

### B.3 Retriever 实现

保留 `KeywordRetriever` 的设计（keyword + recency hybrid scoring），但作为 infrastructure 实现：

新建 `infrastructure/memory/keyword-retriever.ts`，实现 `MemoryRetriever` 端口。

删除其他三个 retriever（BM25Retriever、VectorRetriever、HybridRetriever）——V1 只用 keyword。

### B.4 MemoryTool 重建

在 `memory` extension 中用 `defineTool` 注册 `memory` tool：

```ts
defineTool({
  name: 'memory',
  description: 'Read, write, or search persistent memory...',
  parameters: zodToJsonSchema(memorySchema),
  parse: parseWithZod(memorySchema),
  execute: async (ctx, params) => {
    switch (params.command) {
      case 'search': return retriever.search(params.query, { limit: params.limit });
      case 'add': return store.add({ type: 'general', text: params.text, weight: 0.8, source: 'user' });
      case 'list': return store.getRecent(params.limit ?? 10);
      case 'forget': return store.remove(params.id);
    }
  },
}),
```

注册到中央 `ToolCatalog`：`catalog.register(tool)`。

### B.5 transformPrompt hook 保留

当前 `memory/index.ts` 的 `transformPrompt` hook 已工作——调用 retriever 搜索相关记忆，注入 `<memory>` 标签。保留并整理。

### B.6 onTurnEnd hook 保留

当前 `onTurnEnd` hook 记录 session 摘要。保留。未来可在此触发 LLM auto-extraction（P-9 后续）。

### B.7 收缩 memory/memory/ 目录

删除：
- `retriever.ts`（KeywordRetriever → 移到 infrastructure）
- `bm25-retriever.ts`、`vector-retriever.ts`、`hybrid-retriever.ts`（死代码）
- `embedding-runner.ts`（死代码）
- `agent-md.ts`（死代码）
- `recall.ts`（死代码）
- `sqlite-store.ts`（逻辑合并到 infrastructure adapter）
- `sqlite-schema.ts`（合并）

保留：
- `types.ts`（MemoryConfig）

### B.8 memory.store capability 保留

保留 `provide: { store: () => store }`，供未来 controlplane / RPC 查询。

### B.9 memory.summarized 事件消费者确认

当前 `memory.summarized` 事件 emit 但无订阅者。确认该事件是否需要被 dataplane 转发到 TUI（用于通知用户记忆已更新）。若不需要，从 ContractedEventMap 中移除。

---

## Track C: Evolution — 按 kernel 模式重建

目标：实现原始 self-evolution spec 中的核心流程——
1. **review agent**：独立 fork agent，用轻量 LLM 分析 trace，产出 skill
2. **triggers**：error_burst / complex_task / periodic 触发 review
3. **create_review_skill tool**：写入 `~/.my-agent/skills/auto/`
4. **dedup**：检查已有 skill 名和描述的重复度

### C.1 删除旧 initEvolution 路径

删除 `evolution/evolution/` 下所有仅被 `initEvolution()` 引用的文件：

- `evolution/index.ts`（338 行，`initEvolution` 函数）
- `review-agent.ts`、`skill-analyzer.ts`、`supervisor.ts`
- `triggers.ts`、`cron-scheduler.ts`
- `review-slot.ts`、`review-runner.ts`
- `effectiveness-tracker.ts`
- `prompt-templates.ts`

保留但整理（被 EvolutionCore 使用）：
- `persistent-queue.ts`、`drainer.ts`、`idle-gate.ts`
- `settle-bus.ts`、`circuit-breaker.ts`、`tier-breaker.ts`、`review-backoff.ts`

### C.2 EvolutionCore 整理

`evolution-core.ts` 是当前工作的核心。整理：
- 删除 stub trace payload（`id: ''`）
- 删除 "Stub proposal" fallback
- 正确接入 `provider.llm.call()` 做 LLM review

### C.3 Review Agent 重设计

不是在 extension 内部 new Agent（旧设计），而是：

1. Review trigger（`kernelReady` 后的定期检查 / 手动触发）
2. 从 trace store 读取需要 review 的 trace
3. 用 `provider.llm.call()` 调轻量 LLM（单次调用，非 agent loop）
4. LLM 返回结构化 JSON（skill 建议或 "Nothing to save"）
5. 需要创建 skill 时，直接写文件系统（`~/.my-agent/skills/auto/`）

```
trace store → trigger check → read trace → LLM call (prompt template) → 
  → parse response → if actionable: write SKILL.md → emit event → log
```

### C.4 create_review_skill 重建

不再作为 ZodTool class，改为 `infrastructure/evolution/` 下的纯函数：

```ts
export async function createReviewSkill(
  outputDir: string,
  params: { skill_name: string; description: string; body: string; pitfalls?: string; scripts?: Record<string, string>; references?: Record<string, string> }
): Promise<{ created: boolean; skill_name: string; reason?: string }>
```

- Dedup：检查 outputDir 下已有 skill 目录
- Description overlap：token-overlap > 80% 跳过
- Atomic write：先写临时目录，rename 到目标路径
- 失败时清理

### C.5 evolution.review capability 重新接线

当前 `evolution.review` 无消费者。改成对外暴露可调用的 review 触发器：

```ts
provide: {
  review: () => ({
    requestReview: async (traceId: string) => { /* trigger review */ },
    getPendingProposals: () => [...],
    approveProposal: (id: string) => { /* ... */ },
    rejectProposal: (id: string) => { /* ... */ },
  }),
}
```

### C.6 evolution RPC methods 接线

当前 5 个 RPC（`evolution.status/list/approve/reject/forceReview`）注册但可能无调用者。确认：
- 如果 TUI 需要用这些 RPC → 保留并确保工作
- 如果无消费者 → 删除

### C.7 事件整理

- `evolution.proposal.accepted` / `evolution.proposal.rejected` — 保留（dataplane 转发到 TUI 通知）
- `evolution.progress` / `evolution.skillProposed` — 检查是否有消费者，若无则删除
- `skills.reloaded` — 从 evolution 移到 skills extension（cross-concern）

---

## Track D: Skills — 按 kernel 模式重建

### D.1 删除 middleware.ts

`skills/middleware.ts`（325 行）— `createSkillMiddleware` 和 `SkillMiddlewareResult` 零引用。删除。

### D.2 删除 agent-legacy.ts

`skills/internal/agent-legacy.ts`（48 行）— 旧 `AgentConfig`、`AgentContext`、`Middleware`、`AgentMiddleware`。这些类型仅被 `src/types.ts` 的 deprecated re-export 引用。删除文件 + 删除 types.ts 中的 re-export。

### D.3 SkillLoader 适配 kernel 模式

当前用 `as any` 强转。改为：

```ts
class SkillLoader {
  private sourcePaths: string[];

  constructor(logger: Logger) {
    this.sourcePaths = [
      path.join(process.cwd(), 'skills'),            // 项目 skills/
      path.join(os.homedir(), '.my-agent', 'skills', 'auto'),  // auto-review
    ];
  }

  async loadAll(): Promise<SkillDescriptor[]> {
    // 扫描所有 sourcePaths，按优先级去重
    // 同名 skill：项目 > auto
  }
}
```

删除 `as any` 强转。

### D.4 skills.registry capability 保留

保留 `provide: { registry: () => ({ list, get }) }`，供 controlplane skill RPC 使用。

### D.5 恢复 SkillLoader 的 kernelReady 加载

当前在 `kernelReady` hook 中调 `loader.loadAll()`。确保加载逻辑正确，进度日志合理。

### D.6 清理硬编码 demo skills

`index.ts` 中的 3 个 demo skill（read/write/search）只在无文件 skills 时加载。保留为 fallback，但标记为 `source: 'builtin'` 与文件加载的 `source: 'profile'` 区分。

---

## 不变量

| 不变量 | 内容 |
|--------|------|
| **INV-Trace-1** | trace.writer/reader 是 trace 的唯一对外接口；其他 ext 不得直接读 trace 文件 |
| **INV-Memory-1** | memory tool 通过 defineTool 注册到中央 catalog |
| **INV-Memory-2** | transformPrompt 是 memory 注入的唯一路径；其他 ext 不得自行注入记忆 |
| **INV-Evolution-1** | evolution 不 new Agent；用 provider.llm.call() 做单次 LLM 调用 |
| **INV-Evolution-2** | skills.reloaded 事件仅由 skills extension 发出 |
| **INV-Skills-1** | SkillLoader 支持多源加载（project + auto），同名 skill 项目优先 |
| **INV-Ext-1** | 四个 ext 均不 import 其他 ext 的内部文件 |

---

## Commit Plan

| # | Track | Commit |
|---|-------|--------|
| 1 | A | `chore(p9): delete orphaned trace types, fix dispose to flush not clear` |
| 2 | B | `refactor(p9): add MemoryRetriever port, move KeywordRetriever to infrastructure` |
| 3 | B | `refactor(p9): delete dead retrievers, embedding-runner, agent-md, recall` |
| 4 | B | `refactor(p9): merge SqliteMemoryStore into SqliteMemoryAdapter, fix cross-layer import` |
| 5 | B | `feat(p9): rebuild MemoryTool with defineTool, register to catalog` |
| 6 | B | `chore(p9): shrink memory/memory/ to types.ts only` |
| 7 | C | `chore(p9): delete old initEvolution path — 9 files, ~1545 lines` |
| 8 | C | `refactor(p9): clean EvolutionCore — remove stubs, wire provider.llm.call()` |
| 9 | C | `feat(p9): rebuild createReviewSkill as pure function in infrastructure/evolution/` |
| 10 | C | `refactor(p9): wire evolution.review capability, fix RPC methods, move skills.reloaded to skills` |
| 11 | D | `chore(p9): delete skills/middleware.ts and internal/agent-legacy.ts` |
| 12 | D | `refactor(p9): adapt SkillLoader to kernel — multi-source, no as any casts` |
| 13 | D | `feat(p9): wire skills.registry capability + RPC methods` |

---

## 验证

1. `bun test` 全绿
2. `grep -r "initEvolution" src/` → 0 results
3. `grep -r "createSkillMiddleware" src/` → 0 results
4. `grep -r "AgentConfig\|AgentMiddleware" src/ --include="*.ts" | grep -v agent-legacy` → 0 results
5. memory tool 可通过 `/tools` 命令列出
6. SkillLoader 加载 project + auto 两个源
7. trace dispose 不再清空数据
8. SqliteMemoryAdapter 不再 import extension 内部文件
9. evolution 不 import 其他 extension 目录
10. `skills.reloaded` 仅由 skills extension emit
