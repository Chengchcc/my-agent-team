// Port interface for memory persistence — zero IO, zero adapter imports.

import type { MemoryEntry } from '../../domain/memory-entry'

interface MemoryStore {
  add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry>
  get(id: string): Promise<MemoryEntry | null>
  getAll(): Promise<MemoryEntry[]>
  search(query: string, opts?: { limit?: number; threshold?: number }): Promise<MemoryEntry[]>
  update(id: string, patch: Partial<Pick<MemoryEntry, 'text' | 'weight' | 'tags'>>): Promise<MemoryEntry | null>
  remove(id: string): Promise<boolean>
  getByType(type: MemoryEntry['type'], limit?: number): Promise<MemoryEntry[]>

  /** FTS5 full-text search with BM25 ranking. */
  ftsSearch(query: string, limit: number): Promise<MemoryEntry[]>

  /** sqlite-vec cosine-distance search. Returns entries with distance scores. */
  vectorSearch(queryEmbedding: number[], limit: number): Promise<Array<{ entry: MemoryEntry; distance: number }>>

  /** Store a computed embedding for an entry. */
  storeEmbedding(entryId: string, embedding: number[]): Promise<void>

  /** Find entries that don't have embeddings yet (for backfill). */
  entriesWithoutEmbeddings(batchSize: number): Promise<Array<{ id: string; text: string }>>

  /** Mark entries as hit (updates lastHitAt + usageCount). */
  markHit(ids: string[]): Promise<void>

  /** Delete all entries (for test fixtures). */
  clear(): Promise<void>

  /** Close the store and release resources. */
  close(): Promise<void>
}

export type { MemoryStore }
