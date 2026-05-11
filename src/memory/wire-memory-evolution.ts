import type { Provider } from '../types';
import type { EvolutionModule } from '../evolution';
import type { SqliteMemoryStore } from './sqlite-store';
import { VectorRetriever } from './vector-retriever';
import { EmbeddingTaskRunner } from './embedding-runner';
import { createMemExtractDispatcher, createMemEmbedDispatcher } from './dispatchers';
import type { MemoryMiddleware } from './middleware';
import type { MemoryRetriever } from './types';

export function wireMemoryIntoEvolution(
  evolution: EvolutionModule,
  memorySetup: { middleware: MemoryMiddleware; store: SqliteMemoryStore; retriever: MemoryRetriever },
  provider: Provider,
): void {
  const genStore = memorySetup.store;
  const embeddingRunner = new EmbeddingTaskRunner(
    (text: string) => new VectorRetriever(genStore).encode(text),
    genStore,
  );
  evolution.drainer.setDispatcher('mem-extract', createMemExtractDispatcher({
    provider,
    generalStore: genStore,
    traceStore: evolution.traceStore ?? {
      get: async () => null, appendTurn: async () => {},
      finalize: async () => {}, listBySession: async () => [],
      listRecent: async () => [],
    },
    enqueueEmbed: async (entryId, text) => {
      await evolution.queue.enqueue({
        kind: 'mem-embed',
        priority: 'normal',
        fingerprint: `mem-embed:${entryId}`,
        scheduledBy: 'periodic',
        payload: { kind: 'mem-embed', entryId, text },
      });
    },
  }));
  evolution.drainer.setDispatcher('mem-embed', createMemEmbedDispatcher(embeddingRunner));
}

const BACKFILL_BATCH = 20;\nconst BACKFILL_DELAY_MS = 5000;

/** Fire-and-forget backfill: enqueue low-priority embedding tasks over time. */
export function backfillEmbeddings(
  store: SqliteMemoryStore,
  queue: EvolutionModule['queue'],
): void {
  void (async () => {
    let remaining = true;
    while (remaining) {
      const missing = await store.entriesWithoutEmbeddings(BACKFILL_BATCH);
      if (missing.length === 0) { remaining = false; break; }
      for (const e of missing) {
        await queue.enqueue({
          kind: 'mem-embed', priority: 'low',
          fingerprint: `backfill:${e.id}`, scheduledBy: 'periodic',
          payload: { kind: 'mem-embed', entryId: e.id, text: e.text },
        });
      }
      // Don't flood the queue; wait for drainer to consume before next batch
      await new Promise(r => setTimeout(r, 5000));
    }
  })();
}
