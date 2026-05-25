# Memory Explicit Write — `memory.remember` / `memory.forget` Tools Design

- **Status**: Draft
- **Author**: Lobster Self-Learning Crew
- **Date**: 2026-05-25
- **Depends on**: `2026-05-25-self-learning-go-live-design.md`, `2026-05-25-memory-lifecycle-design.md`
- **Scope**: 让 agent 在对话中**主动**写入/删除记忆,而不是只能依赖被动的 extract worker。提供两个工具:`memory.remember`(写)与 `memory.forget`(删/标记 superseded)。

---

## 0. 背景与问题

现状:agent 没有任何写记忆的入口。所有记忆都靠 trace 完成后的 extract worker 离线提取。两个直接痛点:

1. **延迟**:用户在对话里明确说"记一下我喜欢 dark mode",要等到下一个 review tier 才会被 extract,期间该偏好不参与当前对话的 retrieval。
2. **精度损失**:LLM 在 extract 阶段看到的是完整 trace,容易漏掉用户那句"明确指令"或把它和上下文混在一起摘成模糊的"用户提到外观相关偏好"。

让 agent 显式调用工具去 remember,既即时又精准。配套的 `memory.forget` 用于用户说"忘掉之前关于 X 的设置"。

---

## 1. 设计原则

- **工具最小化**:只暴露两个工具,语义对称(写 / 撤销)。不暴露 search/list,retrieval 已自动跑在 transformPrompt hook 里。
- **写入仍走治理流水线**:`memory.remember` 内部复用 lifecycle spec 的去重 / 矛盾合并管道,不绕过任何治理。
- **forget 是软删除**:默认 `supersede` 而非 `remove`,可恢复;只有用户明确说"彻底删除"才硬删。
- **由 agent 主动调用,不强制**:不在系统提示里硬性要求"必须 remember 用户偏好",只在工具描述里清晰说明用途,让 LLM 自然选用。

---

## 2. 工具定义

### 2.1 `memory.remember`

```ts
{
  name: 'memory.remember',
  description: `Persist a piece of durable knowledge so future conversations can recall it.
Use this when the user explicitly asks to remember something, or when you (the assistant)
identify a stable preference / fact / decision that should outlive this conversation.

Do NOT use for:
- One-off conversation context (use scratchpad)
- Sensitive credentials / secrets
- Information the user explicitly marked as ephemeral`,
  parameters: {
    type: 'object',
    required: ['text', 'type'],
    properties: {
      text: {
        type: 'string',
        description: 'Self-contained statement (one sentence). Avoid pronouns; mention the subject explicitly.',
        maxLength: 500,
      },
      type: {
        type: 'string',
        enum: ['preference', 'fact', 'decision', 'instruction'],
        description: 'Category. preference=stable user taste, fact=immutable knowledge, decision=past choice, instruction=behavioral rule',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional topic tags for grouping (e.g. ["ui", "appearance"])',
        maxItems: 8,
      },
      weight: {
        type: 'number',
        description: 'Initial importance 0.1–1.0. Default 0.6 for explicit remembers.',
        minimum: 0.1,
        maximum: 1.0,
      },
    },
  },
}
```

返回:

```ts
{
  ok: true,
  id: string,                       // 新条目或被命中的旧条目 id
  status: 'created' | 'merged-into-existing' | 'superseded-by-this',
  existingText?: string,            // 若 merged,返回旧条目文本供 LLM 解释
}
```

### 2.2 `memory.forget`

```ts
{
  name: 'memory.forget',
  description: `Mark a previously stored memory as no longer valid.
Use this when the user explicitly revokes or contradicts past instructions/preferences.
By default this is a soft delete (the entry stays but is hidden from retrieval).
Pass hard=true only if the user explicitly says "delete permanently".`,
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language description of what to forget. Will be matched against stored entries via semantic search.',
      },
      type: {
        type: 'string',
        enum: ['preference', 'fact', 'decision', 'instruction'],
        description: 'Optional type filter to narrow the match.',
      },
      hard: {
        type: 'boolean',
        description: 'If true, physically delete. Default false (soft delete via supersede).',
        default: false,
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true to actually delete. If false/omitted, returns matches for user confirmation.',
        default: false,
      },
    },
  },
}
```

返回:

```ts
// confirm=false
{
  ok: true,
  status: 'preview',
  matches: Array<{ id, text, type, tags, weight, lastHitAt }>,  // top-5
  message: 'Confirm by calling again with confirm=true',
}

// confirm=true
{
  ok: true,
  status: 'forgotten',
  affected: number,
  ids: string[],
  mode: 'soft' | 'hard',
}
```

---

## 3. 实现位置

### 3.1 用例层

`src/application/use-cases/memory-explicit-write.ts`,导出两个用例:

```ts
class RememberUseCase {
  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private dedup: DedupPipeline,    // 来自 memory-lifecycle spec
    private bus: ContractBus,
  ) {}

  async execute(input: RememberInput): Promise<RememberResult> {
    // 走完整 §4 治理流水线(lifecycle spec):exact → semantic → contradiction → add
    const decision = await this.dedup.process(input)
    switch (decision.kind) {
      case 'duplicate-exact':
      case 'duplicate-semantic':
        await this.store.markHit([decision.existingId])
        this.bus.emit('memory.remember.merged', {...})
        return { ok: true, id: decision.existingId, status: 'merged-into-existing', ... }

      case 'contradiction-resolved':
        // dedup 内部已完成 supersede + add
        return { ok: true, id: decision.newId, status: 'superseded-by-this', ... }

      case 'new':
        const entry = await this.store.add({
          text: input.text,
          type: input.type,
          tags: input.tags ?? [],
          weight: input.weight ?? 0.6,
        })
        await this.store.storeEmbedding(entry.id, decision.embedding)
        this.bus.emit('memory.remember.created', { id: entry.id })
        return { ok: true, id: entry.id, status: 'created' }
    }
  }
}

class ForgetUseCase {
  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private bus: ContractBus,
  ) {}

  async execute(input: ForgetInput): Promise<ForgetResult> {
    const embedding = await this.embedder.embed(input.query)
    let matches = await this.store.vectorSearch(embedding, 5)
    if (input.type) matches = matches.filter(m => m.entry.type === input.type)

    if (!input.confirm) {
      return {
        ok: true, status: 'preview',
        matches: matches.map(m => ({ ...m.entry })),
        message: 'Confirm by calling again with confirm=true',
      }
    }

    const ids = matches.map(m => m.entry.id)
    if (input.hard) {
      for (const id of ids) await this.store.remove(id)
      this.bus.emit('memory.forget.hard', { ids })
      return { ok: true, status: 'forgotten', affected: ids.length, ids, mode: 'hard' }
    } else {
      // 软删除:用一条"tombstone"条目 supersede 这些目标
      const tombstoneId = (await this.store.add({
        text: `[FORGOTTEN] ${input.query}`,
        type: matches[0]?.entry.type ?? 'instruction',
        tags: ['_tombstone'],
        weight: 0.0,
      })).id
      for (const id of ids) await this.store.supersede(id, tombstoneId)
      this.bus.emit('memory.forget.soft', { ids, tombstoneId })
      return { ok: true, status: 'forgotten', affected: ids.length, ids, mode: 'soft' }
    }
  }
}
```

### 3.2 工具注册

`src/extensions/memory/index.ts` 的 apply 内追加:

```ts
const rememberUseCase = new RememberUseCase(store, embedder, dedupPipeline, bus)
const forgetUseCase = new ForgetUseCase(store, embedder, bus)

return {
  // ... 现有 provide/hooks/subscribe ...

  rpc: {
    'memory.remember': (params) => rememberUseCase.execute(params as RememberInput),
    'memory.forget':   (params) => forgetUseCase.execute(params as ForgetInput),
  },

  tools: [
    {
      name: 'memory.remember',
      description: '...',  // 见 §2.1
      parameters: { ... },
      handler: (args) => rememberUseCase.execute(args as RememberInput),
    },
    {
      name: 'memory.forget',
      description: '...',  // 见 §2.2
      parameters: { ... },
      handler: (args) => forgetUseCase.execute(args as ForgetInput),
    },
  ],
}
```

> 工具的 `handler` 直接复用 RPC handler。两个入口共享 use case 实例,行为一致。

---

## 4. 安全与边界

### 4.1 速率限制

agent 在一次 turn 内调用 `memory.remember` 超过 5 次,后续调用直接返回 `{ ok: false, error: 'rate-limit' }`。防止 LLM 误以为"每条信息都该记",把库写爆。

实现:在 use case 内维护 `perTurnCounter: Map<turnId, number>`,turnId 从 `ctx.currentTurnId` (由 trace 系统注入) 读取。

### 4.2 内容黑名单

`memory.remember` 内部对 text 做硬过滤:

- 长度 < 10 字符 → 拒绝(碎片化记忆无价值)
- 匹配 secret 正则 (sk-..., api_key=..., password=...) → 拒绝并 emit `memory.remember.rejected`
- 匹配 PII 高敏正则(信用卡 / 身份证模式)→ 拒绝

### 4.3 forget 双阶段确认

`confirm=false` 默认行为,强制 LLM 先看一眼匹配结果再决定是否删除。这层"自我审查"避免误删。

### 4.4 软删除 tombstone

软删 tombstone 进入 `_tombstone` 标签,retrieval 排除策略:`tags @> ['_tombstone']` 不参与检索。但保留在库里,人工事后可见"用户曾要求忘记 X"。

---

## 5. 与 extract worker 的协作

extract worker 仍然存在,它现在变成"被动兜底":
- 显式 remember 处理用户**说出口**的部分
- extract worker 处理用户**没说出口但行为已隐含**的部分(比如连续 3 次拒绝 emoji,可被 extract 成 "user dislikes emoji in responses")

两者通过 lifecycle spec §4 的精确去重链路天然合流:explicit remember 写入的条目,若 extract worker 后续又产出相同语义的候选,在 §3 步骤 1-3 就会被 markHit 合并,不会双写。

---

## 6. 可观测性

| 事件                          | payload                          |
|------------------------------|----------------------------------|
| `memory.remember.created`    | `{ id, text, type, source: 'explicit' }`  |
| `memory.remember.merged`     | `{ existingId, candidateText }`  |
| `memory.remember.rejected`   | `{ reason, redactedText }`(text 已脱敏) |
| `memory.forget.soft`         | `{ ids, tombstoneId, query }`    |
| `memory.forget.hard`         | `{ ids, query }`                 |

`source: 'explicit'` vs extract worker 的 `source: 'extract'` 区分,后续可在 retrieval 里给 explicit 来源加权(用户亲口说的更可信)。

---

## 7. 配置

```ts
// src/config/defaults.ts
memory: {
  explicit: {
    enabled: true,
    perTurnLimit: 5,
    defaultWeight: 0.6,
    explicitSourceWeightBoost: 1.2,   // retrieval 时 source==='explicit' 的额外加权
    rejectSecretsPattern: '...regex...',
  }
}
```

---

## 8. UX 示例

```
User: 以后回复用英文吧
Assistant: 好的。[调用 memory.remember({
  text: "User prefers responses in English",
  type: "preference",
  tags: ["language", "response-format"]
})] 已记住,后续会用英文回复。

User: 算了,中英文混着来吧
Assistant: 好的。[调用 memory.forget({
  query: "User prefers English-only responses",
  type: "preference"
})] 
[看到 preview 后调用 memory.forget({..., confirm: true})]
已撤销之前的英文偏好。

User: 永久删除我所有关于语言的偏好
Assistant: [调用 memory.forget({
  query: "language preferences",
  hard: true,
  confirm: true
})] 已彻底删除 3 条语言相关偏好。
```

---

## 9. 验收清单

- [ ] LLM 调用 `memory.remember({text:"用户喜欢 dark mode", type:"preference"})`,DB 立刻多出一条 `source='explicit'` 的条目
- [ ] 同一对话再次 `memory.remember` 相同语义,返回 `status: 'merged-into-existing'`,usageCount++
- [ ] 写入含 `api_key=xxx` 的文本被拒绝,emit `memory.remember.rejected`
- [ ] `memory.forget({query:..., confirm:false})` 返回 top-5 matches,不修改 DB
- [ ] `memory.forget({..., confirm:true, hard:false})`:目标条目 `supersededBy` 指向 tombstone,retrieval 后续不再返回
- [ ] `memory.forget({..., confirm:true, hard:true})`:目标条目从 DB 彻底消失
- [ ] 同一 turn 内第 6 次 `memory.remember` 被 rate-limit 拒绝
- [ ] explicit 来源条目在 retrieval rerank 里得到 1.2× 加权(可在 trace 验证)
