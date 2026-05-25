# Memory Lifecycle — 去重 / 衰减 / 命中加权 Design

- **Status**: Draft
- **Author**: Lobster Self-Learning Crew
- **Date**: 2026-05-25
- **Depends on**: `2026-05-25-self-learning-go-live-design.md`(必须先让 extract worker 真正写库)
- **Scope**: 让记忆条目"活着" —— 防止滚雪球式重复、让久未命中的条目自然衰减、让被高频命中的条目获得权重红利,并能在新旧候选互相矛盾时做合并。

---

## 0. 背景与问题

extract worker 接通 LLM 之后,每个 Tier1 review 都会产出 0~5 条候选记忆。当前 `SqliteMemoryStore.add` 只做插入,没有任何生命周期治理。一周之后会出现:

1. **重复爆炸**:同一条偏好 ("用户喜欢简短回答") 可能被写入几十次,检索时排名机制被噪声主导。
2. **僵尸条目**:三个月前的一次性会话产生的记忆 (例如 "用户正在调研 X 库") 一直留在库里,被 retrieval 拉出来污染当前上下文。
3. **优质条目失去优势**:被反复命中的"用户偏好 TypeScript over Python"和只命中过一次的"用户某次提到 Rust"在 BM25/向量分上没有差异。
4. **矛盾无人裁决**:新候选与旧条目语义矛盾时,两条同时存在,retrieval 一次性返回两条互斥指令。

本 spec 给出"夹生记忆" → "成熟记忆库"所需的最小治理机制,主张**优先用确定性规则,LLM 只在矛盾合并这一步介入**。

---

## 1. 设计原则

- **写入即治理**:`memory.add` 内部完成"精确去重 → 语义相似度检查 → 矛盾合并",而不是事后扫表。
- **读取即衰减**:不做后台 cron,衰减权重在 retrieval rerank 时按 `now - lastHitAt` 现算,数据库只存原始时间戳。
- **命中即加固**:`markHit` 不仅更新时间戳,还根据 `usageCount` 阶梯式提升权重上限。
- **删除是兜底**:只清掉"创建超过 N 天 + 0 次命中 + 权重最低"的三重命中条目,默认不删除任何条目。

---

## 2. 数据模型变更

`MemoryEntry` 新增字段:

| 字段           | 类型       | 默认值     | 用途                                                       |
|----------------|------------|-----------|------------------------------------------------------------|
| `textHash`     | `string`   | sha1(text) | 精确去重的索引列,写入 `memory_entries` 时同步建立 UNIQUE 索引 |
| `usageCount`   | `number`   | 0          | 被 retrieval 命中的累计次数(已有,确认保留)                  |
| `lastHitAt`    | `number`   | createdAt  | 上次命中时间戳,衰减计算用(已有,确认保留)                    |
| `supersededBy` | `string?`  | null       | 矛盾合并时旧条目指向新条目 id,retrieval 时跳过非空条目        |
| `mergeCount`   | `number`   | 0          | 经历过多少次"语义相似/矛盾合并",作为权威性的辅助信号         |

SQL 迁移(新 migration 文件 `005_memory_lifecycle.sql`):

```sql
ALTER TABLE memory_entries ADD COLUMN text_hash TEXT;
ALTER TABLE memory_entries ADD COLUMN superseded_by TEXT REFERENCES memory_entries(id);
ALTER TABLE memory_entries ADD COLUMN merge_count INTEGER NOT NULL DEFAULT 0;

-- 回填 text_hash
UPDATE memory_entries SET text_hash = lower(hex(substr(text, 1, 1024))) WHERE text_hash IS NULL;

CREATE UNIQUE INDEX idx_memory_text_hash ON memory_entries(text_hash) WHERE superseded_by IS NULL;
CREATE INDEX idx_memory_superseded ON memory_entries(superseded_by);
```

> 注:上面 `hex(substr)` 仅是迁移期占位,真正的 hash 由应用层 `sha1` 计算后回写。迁移脚本最后留 TODO 提示首次启动时跑一次回填脚本。

---

## 3. MemoryStore 新增能力

`src/application/ports/memory-store.ts` 追加三个方法,继续遵守"port 不知道实现"原则:

```ts
/** 精确文本去重 —— 命中即返回原条目,无命中返回 null。 */
hasExactDuplicate(args: { text: string; type: MemoryEntry['type'] }): Promise<MemoryEntry | null>

/** 语义相似检索 —— 用 vectorSearch 找 top-1,若 distance < threshold 视为命中。 */
findSemanticDuplicate(args: { embedding: number[]; threshold: number }): Promise<MemoryEntry | null>

/** 把旧条目标记为被 newId 取代;原子事务里同时增加 newId 的 mergeCount。 */
supersede(oldId: string, newId: string): Promise<void>
```

> 命名层面区分清楚:`hasExactDuplicate` 走 hash 索引、O(1);`findSemanticDuplicate` 走向量、O(log n)。两者职责互补。

---

## 4. 写入侧治理流水线

`memory.remember` 用例(或 extract worker 内部用)调用 `MemoryStore.add` 之前,先按下面顺序处理:

```
candidate (text, type, tags)
  │
  ▼ 1. 精确去重
  hasExactDuplicate({text, type})
  │
  ├── 命中 ──▶ markHit([existing.id])  // bump usageCount,丢弃 candidate
  │
  ▼ 2. embedding 计算
  embedding = embedder.embed(text)
  │
  ▼ 3. 语义去重(threshold 默认 0.12,可配置)
  findSemanticDuplicate({embedding, threshold: 0.12})
  │
  ├── 命中且类型一致 ──▶ markHit + mergeCount++,丢弃 candidate
  │
  ├── 命中但类型不同 ──▶ 保留 candidate(可能是不同维度的同一事实)
  │
  ▼ 4. 矛盾检测(仅当类型 ∈ {'preference', 'fact'})
  contradictionCheck(candidate, semanticTopK=3)
  │
  ├── 检出矛盾 ──▶ 走 LLM 仲裁(见 §5)
  │
  ▼ 5. 正式 add + storeEmbedding
```

阈值与开关全部走 `config.memory.lifecycle`:

```ts
interface MemoryLifecycleConfig {
  semanticDedupThreshold: number    // 0.12
  contradictionTopK: number         // 3
  enableContradictionMerge: boolean // true
  decayHalfLifeDays: number         // 30
  pruneAfterDays: number            // 180
  pruneMinUsageCount: number        // 0
}
```

---

## 5. 矛盾仲裁(LLM 介入,默认开启)

只有当 `enableContradictionMerge=true` 且步骤 4 检出疑似矛盾时,才发起一次 LLM 调用:

- **输入**:候选条目 + top-3 语义近邻条目
- **输出**:JSON `{ "decision": "keep_old" | "keep_new" | "merge", "merged_text"?: string }`
- **行为**:
  - `keep_old`:`markHit(oldId)`,丢弃 candidate。
  - `keep_new`:`supersede(oldId, newId)`,写入 candidate。
  - `merge`:写入 `merged_text` 为新条目,`supersede(oldId, newId)`。

矛盾检测的"疑似"信号靠确定性规则给出(避免每条都打 LLM):

- 两条文本在 embedding 上距离 < 0.2 **且**
- 简单文本启发:含相反关键词对 (`prefer/avoid`, `use/don't use`, `always/never`)

实现位置:`src/extensions/memory/contradiction-resolver.ts`,被 `memory.remember` 用例注入。

---

## 6. 读取侧衰减与加权

`HybridRetriever.rerank` 在融合 vector / bm25 / keyword 三路分数后,叠加生命周期权重:

```ts
const ageMs = now - entry.createdAt
const idleMs = now - entry.lastHitAt
const halfLifeMs = config.decayHalfLifeDays * 86_400_000

// 0.5 ~ 1.0 区间,随 idleMs 单调下降
const recencyWeight = Math.pow(0.5, idleMs / halfLifeMs)

// 1.0 ~ 1.5 区间,随 usageCount 阶梯式上升
const usageWeight = 1 + Math.min(0.5, Math.log2(1 + entry.usageCount) * 0.1)

const lifecycleWeight = recencyWeight * usageWeight
finalScore = hybridScore * lifecycleWeight
```

`mergeCount > 0` 的条目额外 ×1.1(被多次确认过的事实更可信)。

`supersededBy != null` 的条目在 `ftsSearch` / `vectorSearch` SQL 层直接 `WHERE superseded_by IS NULL` 过滤掉。

---

## 7. 命中即加固

`markHit` 行为升级:

```sql
UPDATE memory_entries
SET usage_count = usage_count + 1,
    last_hit_at = ?,
    weight = MIN(weight + 0.05, 1.0)
WHERE id IN (...)
```

权重上限 1.0 防止单条无限滚雪球。`+0.05` 配合上面的 `usageWeight` 形成"双层加固":底层权重微调 + retrieval 时阶梯加权。

---

## 8. 清理兜底(prune)

后台不做 cron。提供 RPC `memory.prune`,由 CLI 或运维触发:

```ts
rpc: {
  'memory.prune': async (params: { dryRun?: boolean }) => {
    const candidates = await store.findPruneCandidates({
      olderThanDays: cfg.pruneAfterDays,
      maxUsageCount: cfg.pruneMinUsageCount,
    })
    if (params.dryRun) return { wouldDelete: candidates.length, ids: candidates }
    await store.removeMany(candidates)
    return { deleted: candidates.length }
  }
}
```

默认参数下 (`pruneAfterDays=180, pruneMinUsageCount=0`) 只清"半年没动过、从未被命中过"的条目,极保守。

---

## 9. 可观测性

新增三个事件,trace 系统已经能持久化:

| 事件名                  | payload                                       | 用途                            |
|------------------------|-----------------------------------------------|--------------------------------|
| `memory.dedup`         | `{ kind: 'exact'\|'semantic', existingId }`   | 看真实去重命中率                 |
| `memory.superseded`    | `{ oldId, newId, reason }`                    | 矛盾合并审计                    |
| `memory.prune.applied` | `{ deletedCount, dryRun }`                    | 清理动作留痕                    |

retrieval 侧每次返回 hit 列表时,附带 `lifecycleWeight` 字段写入 trace,便于事后看"为什么这条被选中/被压下去"。

---

## 10. 配置默认值

```ts
// src/config/defaults.ts
memory: {
  lifecycle: {
    semanticDedupThreshold: 0.12,
    contradictionTopK: 3,
    enableContradictionMerge: true,
    decayHalfLifeDays: 30,
    pruneAfterDays: 180,
    pruneMinUsageCount: 0,
  }
}
```

全量开启:§4 全流水线 + §5 矛盾仲裁 + §6 衰减 + §7 加固 + §8 prune 全部默认启用。

---

## 11. 验收清单

- [ ] 同一段文本连续 add 5 次,DB 里只有 1 条 + usageCount=5
- [ ] 语义近似 (cosine < 0.12) 条目不被重复插入,旧条目 mergeCount++
- [ ] 一条 60 天没命中的条目在 retrieval rerank 后排名显著下降(可在 trace 里验证 lifecycleWeight < 0.5)
- [ ] `memory.prune({dryRun:true})` 返回的候选数与手工 SQL 查询一致
- [ ] `enableContradictionMerge=true` 后,模拟两条相反偏好,LLM 仲裁后 DB 内只有一条 `supersededBy=null` 的"新事实"
