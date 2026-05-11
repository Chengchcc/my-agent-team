# Hybrid Memory Retrieval — Design Spec

## Goal

Upgrade memory retrieval from keyword-only to hybrid (keyword + vector) with RRF fusion, using a local embedding model so there are no external API costs.

## Architecture

```
                   ┌─────────────────────┐
                   │   HybridRetriever    │
                   │  (implements         │
                   │   MemoryRetriever)   │
                   └─────────┬───────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼──────┐ ┌────▼──────┐ ┌─────▼─────┐
     │ KeywordRet.   │ │VectorRet. │ │  RRF      │
     │ (unchanged)   │ │ (new)     │ │  Fusion   │
     └───────────────┘ └───────────┘ └───────────┘
```

## New Files

### `src/memory/vector-retriever.ts`

- Implements `MemoryRetriever`
- Loads `Xenova/bge-small-zh` via `@xenova/transformers` (ONNX runtime, pure JS, Bun-compatible)
- `search(query, options)`: encodes query, computes cosine similarity against entries that have embeddings, returns scored results
- `encode(text)`: generates 512-dim embedding vector
- `ensureEmbedding(entry)`: lazy backfill — if an entry lacks `embedding`, encode it and update the store
- Accepts same 3 stores as `KeywordRetriever` (semantic, episodic, project)
- Model loaded once at construction time, cached for lifetime

### `src/memory/hybrid-retriever.ts`

- Implements `MemoryRetriever`
- Wraps `KeywordRetriever` + `VectorRetriever`
- `search()`: runs both retrievers in parallel via `Promise.allSettled`
- Applies **RRF (Reciprocal Rank Fusion)** to merge results

#### RRF Formula

```
RRF_score(entry) = 0.6 / (60 + rank_vector) + 0.4 / (60 + rank_keyword)
```

- k = 60 (standard constant to avoid division by zero)
- Each retriever returns its own ranked list
- Entries appearing in both lists get scores summed; entries in only one get partial score
- Final results sorted by RRF score descending, filtered by threshold, capped at limit

## Modified Files

### `src/memory/index.ts`

Export `VectorRetriever` and `HybridRetriever`.

### `src/runtime.ts` (line 257)

Change from:
```ts
const retriever = new KeywordRetriever(semanticStore, episodicStore, projectStore);
```
To:
```ts
const retriever = new HybridRetriever(
  new KeywordRetriever(semanticStore, episodicStore, projectStore),
  new VectorRetriever(semanticStore, episodicStore, projectStore),
);
```

No changes to `MemoryMiddleware` or `MemoryTool` — they depend on the `MemoryRetriever` interface only.

### `src/config/schema.ts`

Add optional `hybridRetrieval` subsection to `memorySettingsSchema`:

```ts
hybridRetrieval: z.object({
  enabled: z.boolean().default(true),
  modelName: z.string().default('Xenova/bge-small-zh'),
  vectorWeight: z.number().min(0).max(1).default(0.6),
  keywordWeight: z.number().min(0).max(1).default(0.4),
}).default({}),
```

### `src/config/types.ts`

Add `HybridRetrievalConfig` type.

### `package.json`

Add `@xenova/transformers` dependency (latest v2.x).

## Embedding Strategy

- **Write time**: new entries created by `LlmExtractor` get embeddings generated immediately before `store.add()`
- **Lazy backfill**: `VectorRetriever.search()` checks each candidate entry — if `entry.embedding` is missing, it encodes and updates the store on the fly
- **Storage**: `MemoryEntry.embedding` field already exists (`number[]`), no schema change needed

## Edge Cases

| Scenario | Behavior |
|---|---|
| Model download/load fails | HybridRetriever logs warning, falls back to keyword-only |
| Entry has no embedding | VectorRetriever skips it; keyword covers it |
| Very few entries (<10) | RRF still valid, both sides contribute |
| Both retrievers return same entry | RRF naturally deduplicates by summing scores per entry ID |
| Memory store is empty | Both retrievers return [], hybrid returns [] |

## What Does NOT Change

- `KeywordRetriever` — zero modifications
- `MemoryRetriever` interface — unchanged
- `MemoryMiddleware` — unchanged (still gets one retriever)
- `MemoryTool` — unchanged
- `MemoryEntry` type — `embedding` field already present
- `JsonlMemoryStore` — unchanged (already stores `embedding` in JSON)
