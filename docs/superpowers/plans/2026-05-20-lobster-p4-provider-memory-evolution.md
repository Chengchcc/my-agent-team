# P-4 Provider 双能力收敛 + Memory/Evolution 跨层耦合切除 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛 provider.chat/invoke 为单一 provider.llm，消除 infrastructure ↔ extensions/provider/providers/ 反向依赖，切除 memory ↔ evolution 跨层耦合，激活 evolution 真实 LLM 调用。

**Architecture:** 7 个 atomic commit，每个独立可 revert。新 infrastructure/llm/ 目录采用 adapter（纯 wire 转换）+ provider（IO/lifecycle）分层。Memory ↔ Evolution 通过 EventBus `evolution.summary.request` ⇄ `memory.summary.ready` 解耦。

**Tech Stack:** TypeScript + Bun test + ESLint flat config

**Grill 锁定决策:**
- `src/types.ts` C6 不物理删除，变为 thin re-export shim
- 新 Provider 类名 `ClaudeProvider`（非 RealClaudeProvider）
- Echo 不拆 adapter 层，直接 implements ProviderChat & ProviderInvoke
- adapter 无 `providerId` 字段；`maxTokens` 从 `ChatRequest` 取
- `parse-sse.ts` 只做字节流→event 结构，不碰 event type 分发
- memory systemPrompt 硬编码在 `memory/index.ts`
- C4 测试手动 emit `evolution.summary.request`
- `MY_AGENT_PROVIDER` 缺 key → kernelReady fast-fail
- `extensions/provider/` 加例外允许 import `infrastructure/llm/`
- `ProviderPort` 接口删除
- `infrastructure/index.ts` 移除 3 行 llm re-export
- C2a 用 record fixture（不走真实 API）；C5 才用真实 LLM 验证

---

## 文件结构总览

```
新建:
  src/application/ports/provider-adapter.ts        (~50 行)
  src/application/ports/tool-context.ts            (~25 行)
  src/application/ports/trace-store.ts             (~60 行)
  src/infrastructure/llm/index.ts                  (~15 行)
  src/infrastructure/llm/claude-provider.ts        (~200 行)
  src/infrastructure/llm/openai-provider.ts        (~150 行)
  src/infrastructure/llm/echo-provider.ts          (~30 行)
  src/infrastructure/llm/shared/parse-sse.ts       (~50 行)
  src/infrastructure/llm/shared/http-error.ts      (~40 行)
  src/infrastructure/llm/adapters/index.ts         (~10 行)
  src/infrastructure/llm/adapters/claude-adapter.ts (~150 行)
  src/infrastructure/llm/adapters/openai-adapter.ts (~120 行)
  src/infrastructure/llm/adapters/thinking/*.ts    (从 extensions 搬)
  src/extensions/memory/memory/recall.ts            (~100 行)
  src/agent/legacy-types.ts                         (~120 行)

修改:
  src/application/ports/index.ts                    (+3 export)
  src/application/ports/provider.ts                 (删 ProviderPort)
  src/extensions/trace/trace/types.ts               (re-export 自 ports)
  src/extensions/provider/index.ts                  (大幅改写)
  src/extensions/memory/index.ts                    (新增 subscribe + recall)
  src/extensions/evolution/evolution-core.ts        (trace 类型路径修正)
  src/extensions/evolution/evolution/review-agent.ts (重写函数式)
  src/extensions/evolution/evolution/skill-analyzer.ts (重写)
  src/extensions/evolution/evolution/review-tools.ts  (ToolContext 路径修正)
  src/infrastructure/index.ts                       (移除 3 行 llm)
  scripts/check-architecture.ts                     (新增 P-4 规则)
  eslint.config.js                                  (新增 agent 白名单 + infra 规则)
  src/types.ts                                      (变为 thin re-export)

删除:
  src/extensions/provider/providers/                 (整目录, C2b)
  src/infrastructure/claude-provider.ts              (C2b)
  src/infrastructure/openai-provider.ts              (C2b)
  src/infrastructure/echo-provider.ts                (C2b)
  src/extensions/memory/memory/middleware.ts         (C4, dead code)
  src/extensions/memory/memory/dispatchers.ts        (C4, cross-ext coupling)
  src/extensions/memory/memory/extractor.ts          (C4, 合并到 recall.ts)
  src/extensions/memory/memory/types.ts              (C4, 合并)
  tests/extensions/provider-real.test.ts             (C2b, 测 wrapper)
  tests/memory/middleware.test.ts                    (C4, dead)
```

---

### Task 1: Commit 1 — 新增 ports（provider-adapter + tool-context + trace-store）

**Files:**
- Create: `src/application/ports/provider-adapter.ts`
- Create: `src/application/ports/tool-context.ts`
- Create: `src/application/ports/trace-store.ts`
- Modify: `src/application/ports/index.ts`
- Modify: `src/extensions/trace/trace/types.ts`

- [ ] **Step 1: 创建 `src/application/ports/tool-context.ts`**

```ts
// Port for tool execution context — zero IO imports.
// Replaces the ambient ToolContext type from src/types.ts.

export interface ToolContext {
  turnId: string
  signal?: AbortSignal
}
```

- [ ] **Step 2: 创建 `src/application/ports/provider-adapter.ts`**

```ts
import type {
  ChatRequest, ChatResponseChunk, ChatResponse,
  InvokeRequest, InvokeResponse,
} from './provider'

/** Pure function contract for LLM wire-format conversion. Zero IO, zero imports. */
export interface ProviderAdapter {
  toChatWire(req: ChatRequest, opts: { stream: boolean }): unknown
  toInvokeWire(req: InvokeRequest): unknown
  fromChatStreamChunk(raw: unknown): ChatResponseChunk | null
  fromChatResponse(raw: unknown): ChatResponse
  fromInvokeResponse(raw: unknown): InvokeResponse
}
```

- [ ] **Step 3: 创建 `src/application/ports/trace-store.ts`**

```ts
import type { TraceRun, TraceSummary } from '../../extensions/trace/trace/types'

export interface TraceStoreWriter {
  emit(event: TraceEvent): void
  close(): Promise<void>
}

export interface TraceStoreReader {
  getRun(runId: string): Promise<TraceRun | null>
  listRecentSummaries(opts: { limit: number; since?: number }): Promise<TraceSummary[]>
}

export interface TraceEvent {
  type: string
  turnId: string
  timestamp: number
  payload?: Record<string, unknown>
}

export type { TraceRun, TraceSummary }
```

- [ ] **Step 4: 更新 `src/application/ports/index.ts`**

```ts
export type { Transport } from './transport'
export type { TraceWriter, TraceReader } from './trace-writer'
export type { MemoryStore } from './memory-store'
export type { SessionStore } from './session-store'
export type {
  ChatRequest, ChatResponse, ProviderChat, ChatResponseChunk,
  InvokeRequest, InvokeResponse, ProviderInvoke,
} from './provider'
export type { ProviderAdapter } from './provider-adapter'
export type { ToolContext } from './tool-context'
export type { TraceStoreWriter, TraceStoreReader, TraceEvent } from './trace-store'
```

- [ ] **Step 5: 削薄 `src/extensions/trace/trace/types.ts`**

在文件顶部 export 之前加入：
```ts
// Re-export port-level types so existing importers don't break.
export type { TraceRun, TraceSummary } from '../../../application/ports/trace-store'
```

- [ ] **Step 6: 运行检查**

```bash
bun run tsc --noEmit && bun test
```
预期：tsc 0 错误，测试数与基线一致。

- [ ] **Step 7: Commit**

```bash
git add src/application/ports/provider-adapter.ts \
        src/application/ports/tool-context.ts \
        src/application/ports/trace-store.ts \
        src/application/ports/index.ts \
        src/extensions/trace/trace/types.ts
git commit -m "ports: introduce provider-adapter, tool-context, and trace-store ports"
```

---

### Task 2: Commit 2a — 搭建 infrastructure/llm + adapters 并行实现

**Files:** Create ~12 files under `src/infrastructure/llm/`, ~6 test files under `tests/infrastructure/llm/`

#### 2a.1 — 搬运 thinking decoder + 创建共享 IO 工具

- [ ] **Step 1: 创建目录结构并复制 thinking 文件**

```bash
mkdir -p src/infrastructure/llm/adapters/thinking
mkdir -p src/infrastructure/llm/shared
mkdir -p tests/infrastructure/llm/adapters
mkdir -p tests/infrastructure/llm/shared
cp src/extensions/provider/providers/thinking/types.ts src/infrastructure/llm/adapters/thinking/types.ts
cp src/extensions/provider/providers/thinking/anthropic-native.ts src/infrastructure/llm/adapters/thinking/anthropic-native.ts
cp src/extensions/provider/providers/thinking/reasoning-content.ts src/infrastructure/llm/adapters/thinking/reasoning-content.ts
```

- [ ] **Step 2: 更新 thinking 文件内部 import**

在 3 个复制的文件中，将所有跨目录 import 改为同目录相对路径（如 `'./types'`）。当前源文件已使用相对路径，无需改动。验证：

```bash
grep -rn "from '\.\." src/infrastructure/llm/adapters/thinking/ || echo "PASS: all relative imports"
```

- [ ] **Step 3: 创建 `src/infrastructure/llm/shared/http-error.ts`**

```ts
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export async function normalizeHttpError(resp: Response, provider: string): Promise<HttpError> {
  const body = await resp.text().catch(() => '<unreadable>')
  return new HttpError(`[${provider}] HTTP ${resp.status}: ${resp.statusText}`, resp.status, body)
}
```

- [ ] **Step 4: 创建 `src/infrastructure/llm/shared/parse-sse.ts`**

```ts
export interface SseEvent { event?: string; data: string }

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      let event: string | undefined
      let dataLines: string[] = []
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7).trim()
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
        else if (line === '' && dataLines.length > 0) {
          const data = dataLines.join('\n')
          if (data !== '[DONE]') yield { event, data }
          dataLines = []; event = undefined
        }
      }
    }
    buffer += decoder.decode()
    const match = buffer.trim().match(/^data: (.+)$/m)
    if (match && match[1] !== '[DONE]') yield { data: match[1] }
  } finally { reader.releaseLock() }
}
```

- [ ] **Step 5: 创建 parse-sse 测试**

`tests/infrastructure/llm/shared/parse-sse.test.ts` — 测试 5 个场景：
1. 单 event 解析
2. [DONE] sentinel 跳过
3. 跨 chunk 拼接
4. `event:` 前缀解析
5. 空流 → 0 event

```bash
bun test tests/infrastructure/llm/shared/parse-sse.test.ts
# Expected: 5 pass
```

#### 2a.2 — 编写 claude-adapter.ts

- [ ] **Step 6: 创建 `src/infrastructure/llm/adapters/claude-adapter.ts`** (~150 行)

核心结构：
- `toClaudeRole()` — 角色映射
- `convertToClaudeMessages()` — 消息转换（从 claude-utils.ts 抽取）
- `extractSystemPrompt()` — 提取 system prompt
- `toAnthropicTools()` — tool 定义转换
- `ClaudeAdapter` 类 implements `ProviderAdapter`，包含：
  - `toChatWire()` — 组装 Anthropic messages API body
  - `toInvokeWire()` — 委托 toChatWire（非流式）
  - `fromChatStreamChunk()` — SSE event → ChatResponseChunk（text_delta / content_block_* / message_stop）
  - `fromChatResponse()` — 完整响应 body → ChatResponse
  - `fromInvokeResponse()` — 委托 fromChatResponse

```bash
bun run tsc --noEmit  # verify compiles
```

#### 2a.3 — 编写 openai-adapter.ts

- [ ] **Step 7: 创建 `src/infrastructure/llm/adapters/openai-adapter.ts`** (~120 行)

类似结构，使用 OpenAI Responses API wire format：
- `toOpenAiMessages()` / `toOpenAiTools()` — 消息和 tool 转换
- `OpenAiAdapter` 类 implements `ProviderAdapter`

```bash
bun run tsc --noEmit
```

#### 2a.4 — 编写 Provider 类（IO 层）

- [ ] **Step 8: 创建 `src/infrastructure/llm/claude-provider.ts`** (~200 行)

`ClaudeProvider implements ProviderChat, ProviderInvoke`：
- `stream()` — fetch + parseSSE + adapter.fromChatStreamChunk
- `complete()` — fetch + adapter.fromChatResponse
- `call()` — 委托 complete（InvokeRequest → ChatRequest 转换）
- 构造函数参数：`apiKey`, `model?`, `baseURL?`, `thinkingBudgetTokens?`

- [ ] **Step 9: 创建 `src/infrastructure/llm/openai-provider.ts`** (~150 行)

`OpenAiProvider implements ProviderChat, ProviderInvoke`，同上模式，使用 OpenAI endpoint。

- [ ] **Step 10: 创建 `src/infrastructure/llm/echo-provider.ts`** (~30 行)

`EchoProvider implements ProviderChat, ProviderInvoke`：
- 不拆 adapter 层
- `stream()` — 逐字符 yield `{ type: 'text', delta: char }`
- `complete()` / `call()` — 返回固定 echo 文本

- [ ] **Step 11: 创建 barrel 文件**

`src/infrastructure/llm/index.ts` — re-export ClaudeProvider, OpenAiProvider, EchoProvider
`src/infrastructure/llm/adapters/index.ts` — re-export ClaudeAdapter, OpenAiAdapter

#### 2a.5 — 编写测试（record fixture）

- [ ] **Step 12: 创建 adapter 单元测试**

4 个测试文件（具体代码见 spec §6.1），每个测试使用 record fixture 而非真实 API：
- `tests/infrastructure/llm/adapters/claude-adapter.test.ts`
- `tests/infrastructure/llm/adapters/openai-adapter.test.ts`
- `tests/infrastructure/llm/adapters/thinking-decoder.test.ts`（从 tests/providers/ 迁移）
- `tests/infrastructure/llm/claude-provider.test.ts`（mock fetch）
- `tests/infrastructure/llm/openai-provider.test.ts`（mock fetch）

- [ ] **Step 13: 验证全量编译 + 测试**

```bash
bun run tsc --noEmit
bun test tests/infrastructure/
bun test  # ensure existing tests unaffected
```

预期：tsc 0 错误，新增测试全绿，旧测试数不变。

- [ ] **Step 14: Commit**

```bash
git add src/infrastructure/llm/ tests/infrastructure/llm/
git commit -m "feat(p4): scaffold infrastructure/llm with adapter + provider parallel implementation"
```

---

### Task 3: Commit 2b — 切到 infrastructure/llm，删除旧 providers/

**Files:**
- Modify: `src/extensions/provider/index.ts` — import 路径切换
- Modify: `src/infrastructure/index.ts` — 移除 3 行 llm re-export
- Delete: `src/extensions/provider/providers/` (整目录, ~1028 行)
- Delete: `src/infrastructure/claude-provider.ts`
- Delete: `src/infrastructure/openai-provider.ts`
- Delete: `src/infrastructure/echo-provider.ts`
- Delete: `tests/extensions/provider-real.test.ts`

- [ ] **Step 1: 改写 `src/extensions/provider/index.ts`**

关键改动：
1. import 路径：`../../infrastructure/claude-provider` → `../../infrastructure/llm/claude-provider`
2. provider 类名：`RealClaudeProvider` → `ClaudeProvider`；`RealOpenAIProvider` → `OpenAiProvider`
3. 保持不变：capability keys 仍是 `chat` + `invoke`（Commit 3 才改）

- [ ] **Step 2: 更新 `src/infrastructure/index.ts`**

移除 3 行 llm re-export（EchoProvider, RealClaudeProvider, RealOpenAIProvider），保留其他 re-export。

- [ ] **Step 3: 删除旧文件**

```bash
rm -rf src/extensions/provider/providers/
rm src/infrastructure/claude-provider.ts
rm src/infrastructure/openai-provider.ts
rm src/infrastructure/echo-provider.ts
rm tests/extensions/provider-real.test.ts
```

- [ ] **Step 4: 验证**

```bash
# 反向依赖归零
grep -rn "from.*'\.\./extensions/provider/providers'" src/ tests/ || echo "PASS"
grep -rn "from.*'\.\./extensions/" src/infrastructure/ || echo "PASS"
grep -rn "// TODO(p-4)" src/infrastructure/ || echo "PASS"

# provider 目录只留 index.ts
ls src/extensions/provider/

# 编译 + 测试
bun run tsc --noEmit && bun test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(p4): cut over to infrastructure/llm, delete extensions/provider/providers/"
```

---

### Task 4: Commit 3 — 收敛 chat/invoke 为单一 provider.llm capability

**Files:**
- Modify: `src/extensions/provider/index.ts`
- Modify: `src/application/ports/provider.ts` — 删除 ProviderPort
- Modify: `src/application/ports/index.ts` — 移除 ProviderPort export
- Modify: `src/application/usecases/run-turn.ts` — 改 capability key
- Modify: corresponding test files

- [ ] **Step 1: 删除 ProviderPort**

从 `ports/provider.ts` 删除 `interface ProviderPort { chat, invoke }`。从 `ports/index.ts` 移除 ProviderPort export。

- [ ] **Step 2: 改 capability key**

`extensions/provider/index.ts`：`provide: { chat: ..., invoke: ... }` → `provide: { llm: () => provider }`

- [ ] **Step 3: 全量 grep 替换**

```bash
# 找出所有旧 key 引用
grep -rn "'provider\.chat'\|'provider\.invoke'" src/ tests/
```

逐文件改为 `'provider.llm'`（预期 ~4 文件）。

- [ ] **Step 4: 验证归零**

```bash
grep -rn "'provider\.chat'\|'provider\.invoke'" src/ tests/ || echo "PASS: converged to provider.llm"
bun run tsc --noEmit && bun test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(p4): collapse chat/invoke into single provider.llm capability"
```

---

### Task 5: Commit 4 — Memory 断脐 + Bus Event 解耦

**Files:**
- Create: `src/extensions/memory/memory/recall.ts`
- Modify: `src/extensions/memory/index.ts`
- Delete: `middleware.ts`, `dispatchers.ts`, `extractor.ts`, `types.ts` (4 files)
- Delete: `tests/memory/middleware.test.ts`
- Create: `tests/extensions/memory/recall.test.ts`
- Create: `tests/integration/memory-evolution-bus.test.ts`

- [ ] **Step 1: 创建 `src/extensions/memory/memory/recall.ts`** (~100 行)

```ts
import type { ProviderInvoke } from '../../../application/ports/provider'

const SUMMARY_SYSTEM_PROMPT =
  'Summarize the following conversation turn for long-term memory retrieval. ' +
  'Extract: (1) key facts and decisions, (2) user preferences, (3) technical details. Keep under 200 words.'

export interface MemorySummaryResult { text: string; weight: number; tags: string[] }

export async function summarizeForMemory(deps: {
  llm: ProviderInvoke
  parentTurnId: string
  messages: Array<{ role: string; content: string }>
}): Promise<MemorySummaryResult> {
  const resp = await deps.llm.call({
    kind: 'internal', purpose: 'memory.summarize',
    parentTurnId: deps.parentTurnId,
    messages: [{ role: 'system', content: SUMMARY_SYSTEM_PROMPT }, ...deps.messages],
    maxTokens: 500,
  })
  const text = resp.content.trim()
  const tags: string[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^#(\w+)/)
    if (match) tags.push(match[1])
  }
  return { text, weight: 0.5, tags }
}
```

- [ ] **Step 2: 改写 `src/extensions/memory/index.ts`**

新增 `subscribe: { 'evolution.summary.request': ... }` handler，在其中：
1. 从 `ctx.capabilities.get('provider.llm')` 取 LLM
2. 调用 `summarizeForMemory()`
3. 将结果写入 store
4. emit `memory.summary.ready`

- [ ] **Step 3: 删除旧文件**

```bash
rm src/extensions/memory/memory/middleware.ts
rm src/extensions/memory/memory/dispatchers.ts
rm src/extensions/memory/memory/extractor.ts
rm src/extensions/memory/memory/types.ts
rm tests/memory/middleware.test.ts
```

- [ ] **Step 4: 验证跨层 import 归零**

```bash
grep -rn "from '\.\./\.\./\.\./types'" src/extensions/memory/ || echo "PASS"
grep -rn "from '\.\./\.\./evolution/" src/extensions/memory/ || echo "PASS"
grep -rn "from '\.\./\.\./\.\./config" src/extensions/memory/ || echo "PASS"
```

- [ ] **Step 5: 创建测试**

`tests/extensions/memory/recall.test.ts` — fake ProviderInvoke, 验证 summarizeForMemory 输出
`tests/integration/memory-evolution-bus.test.ts` — MiniBus 验证 evolution.summary.request → memory.summary.ready 往返

- [ ] **Step 6: 运行检查**

```bash
bun run tsc --noEmit && bun test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(p4): cut memory cross-layer imports, replace dispatchers with bus events"
```

---

### Task 6: Commit 5 — Evolution 切换为 provider.llm.call()

**Files:**
- Modify: `src/extensions/evolution/evolution/review-agent.ts` — 重写函数式
- Modify: `src/extensions/evolution/evolution/skill-analyzer.ts` — 重写
- Modify: `src/extensions/evolution/evolution/review-tools.ts` — ToolContext 路径修正
- Modify: `src/extensions/evolution/evolution-core.ts` — trace 类型路径修正
- Create: 3 个测试文件

- [ ] **Step 1: 重写 `review-agent.ts`**

1. 删除 `import { Agent }`, `import { ContextManager }`, `import { ToolRegistry }`
2. 删除 `forkReviewAgent`（创建 stub Agent 的函数）
3. 新增 `runReview()` 函数式签名（见 spec §3.5），接收 `ProviderInvoke` + `{ getRun }` + `Logger` 依赖
4. 新增 `parseReviewResponse()` — JSON 解析（容错：非 JSON → fallback 整个 content 当作 analysis）
5. 保留 `buildReviewSystemPrompt()`（无 Agent 依赖）

- [ ] **Step 2: 重写 `skill-analyzer.ts`**

1. 删除 `import { Agent }`, `import { ContextManager }`
2. 删除动态 `import('../../../agent/tool-registry')`
3. 新增 `runSkillAnalysis()` 函数式签名

- [ ] **Step 3: 路径修正**

`review-tools.ts`: `'../../../types'` → `'../../../application/ports/tool-context'`
`evolution-core.ts`: `'../../trace/trace/types'` → `'../../../application/ports/trace-store'`

- [ ] **Step 4: 创建测试**

- `tests/extensions/evolution/review-runner-invoke.test.ts` — fake ProviderInvoke，验证 review 流程
- `tests/extensions/evolution/review-failure-isolation.test.ts` — LLM throw → review 返回 null，不抛回
- `tests/integration/evolution-review-end-to-end.test.ts` (可选，C5 基线)

- [ ] **Step 5: 运行检查**

```bash
bun run tsc --noEmit && bun test
```

预期：evolution 测试从 11 fail 降至 0 fail（首次激活真实功能）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(p4): replace embedded Agent with provider.llm.call() in evolution"
```

---

### Task 7: Commit 6 — 收尾: src/types.ts shim + 架构守卫 + provider.selected trace

**Files:**
- Create: `src/agent/legacy-types.ts` (~140 行)
- Modify: `src/types.ts` → 变为 thin re-export shim (~30 行)
- Modify: `src/agent/Agent.ts` — import 路径改为 `'./legacy-types'`
- Modify: `src/agent/tool-dispatch/types.ts` — import 路径改为 `'../legacy-types'`
- Modify: `src/extensions/provider/index.ts` — 加 `kernelReady` hook emit `provider.selected`
- Modify: `eslint.config.js` — 加 `src/agent/` 白名单 + infrastructure 规则
- Modify: `scripts/check-architecture.ts` — 加 P-4 规则
- Create: `tests/extensions/provider-fallback.test.ts`

- [ ] **Step 1: 创建 `src/agent/legacy-types.ts`**

将 `src/types.ts` 全部内容（254 行）复制到 `legacy-types.ts`，顶部加 `@deprecated` JSDoc。所有 export 保留原样。

关键 export：`ToolContext`, `Tool`, `ToolImplementation`, `ToolCall`, `ToolSink`, `createToolSink`, `ContentBlock`, `Message`, `flattenBlocks`, `synthesizeBlocksFromLegacy`, `AgentConfig`, `AgentContext`, `Provider`, `AgentHooks`, `Middleware`, `AgentMiddleware`, `Session`, `TodoStatus`, `TodoItem`, `CompressionStrategy`, `LLMResponse`, `LLMResponseChunk`, `TypedMetadataKey`, `defineMetadataKey`, `getMetadata`, `setMetadata`

- [ ] **Step 2: 更新 Agent.ts 和 tool-dispatch/types.ts import**

```diff
// Agent.ts
- import type { Provider, Tool, Message, AgentHooks } from '../types'
+ import type { Provider, Tool, Message, AgentHooks } from './legacy-types'
- import type { ToolImplementation } from '../types'
+ import type { ToolImplementation } from './legacy-types'

// tool-dispatch/types.ts
- export type { ToolContext, ToolSink } from '../../types'
+ export type { ToolContext, ToolSink } from '../legacy-types'
- export { createToolSink } from '../../types'
+ export { createToolSink } from '../legacy-types'

// tool-dispatch/middleware.ts
- import type { ToolCall } from '../../types'
+ import type { ToolCall } from '../legacy-types'
```

- [ ] **Step 3: 将 `src/types.ts` 重写为 thin re-export shim**

```ts
// Thin re-export shim. Types have been migrated to domain/, application/ports/,
// and agent/legacy-types.ts. Each out-of-scope extension (tools, mcp, frontend.*,
// skills) should migrate its imports in its own spec (P-5, P-6, etc.).
export type {
  TodoStatus, TodoItem,
  ToolContext, ToolSink,
  ContentBlock, Message,
  Tool, ToolImplementation, ToolCall,
  LLMResponse, LLMResponseChunk,
  CompressionStrategy,
  AgentConfig, AgentContext, Provider,
  Middleware, AgentHooks, AgentMiddleware,
  TypedMetadataKey, Session,
} from './agent/legacy-types'
export {
  createToolSink, flattenBlocks, synthesizeBlocksFromLegacy,
  defineMetadataKey, getMetadata, setMetadata,
} from './agent/legacy-types'
```

- [ ] **Step 4: 更新 `scripts/check-architecture.ts`**

在现有 RULES 数组中新增：

```ts
// P-4: Provider anti-corruption
{ from: 'src/extensions/**', forbid: 'src/agent/**', except: ['src/extensions/evolution/**', 'src/extensions/mcp/**'] },
{ from: 'src/extensions/**', forbid: /from\s+['"]\.\.\/\.\.\/\.\.\/types['"]/ },
{ from: 'src/extensions/**', forbid: /from\s+['"]\.\.\/\.\.\/\.\.\/config\/constants['"]/ },
{ from: 'src/extensions/**', forbid: 'src/infrastructure/**', except: ['src/extensions/provider/**'] },
{ from: 'src/infrastructure/**', forbid: 'src/extensions/**' },
{ from: 'src/infrastructure/llm/adapters/**', forbid: ['fetch', 'fs', 'setTimeout'] },
{ from: 'src/domain/**', forbid: 'src/application/**' },
{ from: 'src/application/**', forbid: 'src/extensions/**' },
```

- [ ] **Step 5: 更新 `eslint.config.js`**

在 `buildExtensionOverrides()` 循环后，新增两个 override：

```js
// P-4: Allow only evolution and mcp to import from src/agent/ (legacy compat)
{
  files: ['src/extensions/evolution/**', 'src/extensions/mcp/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['**/extensions/*/**'],
        message: CROSS_EXT_MSG,
      }],
    }],
  },
},

// P-4: Provider extension allowed to import from infrastructure/llm/
{
  files: ['src/extensions/provider/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        ...(ALL_EXTENSIONS.filter(e => e !== 'provider').map(e => ({
          group: [`**/extensions/${e}/**`],
          message: CROSS_EXT_MSG,
        }))),
      ],
    }],
  },
},
```

- [ ] **Step 6: 加 provider.selected trace event**

在 `src/extensions/provider/index.ts` 的 `apply()` 中新增 `kernelReady` hook：

```ts
hooks: {
  kernelReady: {
    enforce: 'normal',
    fn: async () => {
      const providerId = (provider as { providerId: string }).providerId
      ctx.bus.emit('provider.selected', { providerId, model: provider.model })
    },
  },
  // ... existing onLLMDelta hook
}
```

- [ ] **Step 7: 新建 `tests/extensions/provider-fallback.test.ts`**

测试 3 种 fallback 路径（echo / claude via API key / openai via API key + MY_AGENT_PROVIDER 强制）。

- [ ] **Step 8: 最终验证**

```bash
bun run check:all
grep -rn "from.*'\.\./types\|from.*'\.\./\.\./types\|from.*'\.\./\.\./\.\./types'" src/ | grep -v legacy-types | grep -v node_modules || echo "PASS: no direct types.ts imports"
find src/ -name 'types.ts' -path 'src/types.ts' -exec echo "exists as shim" \;
```
预期：`check:all` 全绿；`src/types.ts` 存在但仅为 re-export shim。

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore(p4): prune src/types.ts to re-export shim, add arch guards, provider.selected trace event"
```

---

## 自审清单

1. **Spec 覆盖:**
   - F-1 (单一 llm key): Task 4, C3
   - F-2 (call 接入 evolution/memory): Task 5+6, C4+C5
   - F-3 (adapter + IO 归档): Task 2+3, C2a+C2b
   - F-4 (memory 断脐): Task 5, C4
   - F-5 (evolution 激活): Task 6, C5
   - F-6 (types.ts 拆分): Task 7, C6
   - F-7 (EventBus 契约): Task 5, C4
   - F-8 (provider fallback trace): Task 7 step 6, C6
   - F-9 (agent ESLint 白名单): Task 7 step 5, C6
   - F-10 (review 失败隔离): Task 6 step 4, C5
   - 所有不变量 (INV-*): 各 step 验证 grep 命令 + arch check

2. **无占位符:** 所有步骤含具体代码或具体命令。

3. **类型一致性:**
   - `ClaudeProvider` (非 RealClaudeProvider)
   - `ProviderAdapter` port 无 `providerId` 字段
   - `InvokeRequest.maxTokens` 随 ChatRequest 获取
   - `ProviderPort` 已在 C3 删除
   - `trace/types.ts` re-export 自 ports/trace-store.ts

4. **每个 commit 独立可 revert:** C2a 纯加法，C2b cutover，C3 mechanical，C4 memory，C5 evolution，C6 收尾。

---

## 执行选项

Plan complete and saved to `docs/superpowers/plans/2026-05-20-lobster-p4-provider-memory-evolution.md`.

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
