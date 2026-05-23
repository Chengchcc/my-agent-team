import type { MemoryStore } from '../../application/ports/memory-store'
import type { EmbeddingEncoder } from './retrievers'

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_BATCH = 16

export interface BackfillHandle { start(): void; stop(): void }

export function createEmbeddingBackfill(
  store: MemoryStore,
  encoder: EmbeddingEncoder,
  debugLog: (domain: string, msg: string) => void,
  opts: { intervalMs?: number; batchSize?: number } = {},
): BackfillHandle {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const batch = opts.batchSize ?? DEFAULT_BATCH
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function tick() {
    if (running) return
    running = true
    try {
      const pending = await store.entriesWithoutEmbeddings(batch)
      if (pending.length === 0) return
      let done = 0
      for (const { id, text } of pending) {
        try {
          const emb = await encoder.encode(text)
          await store.storeEmbedding(id, emb)
          done++
        } catch (err) {
          debugLog('memory.backfill', `skip ${id}: ${String(err)}`)
        }
      }
      if (done > 0) debugLog('memory.backfill', `backfilled ${done}/${pending.length}`)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => { void tick() }, interval)
      void tick()
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null }
    },
  }
}
