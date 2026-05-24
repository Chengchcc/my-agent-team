import { describe, it, expect } from 'bun:test'
import {
  KeywordRetriever, HybridRetriever, VectorRetriever, Bm25Retriever,
} from '../../../src/extensions/memory/retrievers'
import type { Retriever, EmbeddingEncoder } from '../../../src/extensions/memory/retrievers'
import type { MemoryEntry } from '../../../src/domain/memory-entry'
import type { MemoryStore } from '../../../src/application/ports/memory-store'

function makeEntry(id: string, text: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id, text,
    createdAt: new Date('2026-05-01'),
    lastHitAt: new Date('2026-05-24'),
    usageCount: 3,
    weight: 1,
    tags: [],
    ...overrides,
  }
}

/** Stub MemoryStore: returns a fixed set of entries from search() */
function stubStore(entries: MemoryEntry[]): MemoryStore {
  return {
    add: async () => ({ id: 'x', text: '', createdAt: new Date(), lastHitAt: null, usageCount: 0, weight: 1, tags: [] }),
    get: async () => null,
    update: async () => {},
    remove: async () => false,
    search: async () => entries,
    ftsSearch: async () => entries,
    vectorSearch: async () => entries.map(e => ({ entry: e, distance: 0.5 })),
    markHit: async () => {},
    listAll: async () => entries,
    count: async () => entries.length,
  }
}

describe('KeywordRetriever', () => {
  it('returns empty when query has no tokens', async () => {
    const ret = new KeywordRetriever(stubStore([]))
    const results = await ret.search('')
    expect(results).toEqual([])
  })

  it('returns empty when no candidates match', async () => {
    const ret = new KeywordRetriever(stubStore([
      makeEntry('1', 'hello world'),
    ]))
    const results = await ret.search('zzz')
    expect(results).toEqual([])
  })

  it('returns scored results sorted by relevance', async () => {
    const ret = new KeywordRetriever(stubStore([
      makeEntry('1', 'hello world', { weight: 1 }),
      makeEntry('2', 'hello world foo bar', { weight: 5, usageCount: 10 }),
    ]))
    const results = await ret.search('hello world', { limit: 10 })
    // Entry 2 has higher weight and usageCount → higher score → first
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.id).toBe('2')
  })

  it('respects limit', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry(`${i}`, `common term ${i}`),
    )
    const ret = new KeywordRetriever(stubStore(entries))
    const results = await ret.search('common', { limit: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
  })
})

describe('VectorRetriever', () => {
  it('returns empty when encoder throws (degraded mode)', async () => {
    const failingEncoder: EmbeddingEncoder = {
      encode: async () => { throw new Error('embedding service down') },
    }
    const ret = new VectorRetriever(stubStore([makeEntry('1', 'hello')]), failingEncoder)
    const results = await ret.search('hello')
    expect(results).toEqual([])
  })

  it('returns entries when encoder succeeds', async () => {
    const encoder: EmbeddingEncoder = {
      encode: async () => [0.1, 0.2, 0.3],
    }
    const ret = new VectorRetriever(stubStore([makeEntry('1', 'hello')]), encoder)
    const results = await ret.search('hello')
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe('1')
  })
})

describe('HybridRetriever', () => {
  function makeStubRetriever(results: MemoryEntry[]): Retriever {
    return { search: async () => results }
  }

  it('fuses results from all three retrievers via RRF', async () => {
    const kw = makeStubRetriever([makeEntry('a', 'kw result')])
    const bm = makeStubRetriever([makeEntry('b', 'bm25 result')])
    const vec = makeStubRetriever([makeEntry('c', 'vec result')])
    const hybrid = new HybridRetriever(kw, bm, vec)
    const results = await hybrid.search('test', { limit: 5 })
    expect(results.length).toBe(3)
    const ids = results.map(r => r.id).sort()
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('handles degraded vector retriever (encoder failure) — falls back to BM25 + keyword only', async () => {
    // DESIGN.md gap #6: vector throws → fall back to remaining retrievers
    const kw = makeStubRetriever([makeEntry('kw1', 'keyword match')])
    const bm = makeStubRetriever([makeEntry('bm1', 'bm25 match')])
    const failingVec: Retriever = {
      search: async () => { throw new Error('vector down') },
    }
    const hybrid = new HybridRetriever(kw, bm, failingVec)
    const results = await hybrid.search('test', { limit: 5 })
    // Should still return results from keyword + bm25
    expect(results.length).toBe(2)
    const ids = results.map(r => r.id).sort()
    expect(ids).toEqual(['bm1', 'kw1'])
  })

  it('deduplicates entries across retrievers', async () => {
    const shared = makeEntry('shared', 'appears in both')
    const kw = makeStubRetriever([shared])
    const bm = makeStubRetriever([shared])
    const vec = makeStubRetriever([])
    const hybrid = new HybridRetriever(kw, bm, vec)
    const results = await hybrid.search('test', { limit: 5 })
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe('shared')
  })

  it('handles all three retrievers failing', async () => {
    const failing: Retriever = { search: async () => { throw new Error('down') } }
    const hybrid = new HybridRetriever(failing, failing, failing)
    const results = await hybrid.search('test', { limit: 5 })
    expect(results).toEqual([])
  })
})
