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

const BACKFILL_BATCH = 20;

/** One-shot backfill: enqueue mem-embed tasks for entries without embeddings. */
export async function backfillEmbeddings(
  store: SqliteMemoryStore,
  queue: EvolutionModule['queue'],
): Promise<number> {
  let enqueued = 0;
  const missing = await store.entriesWithoutEmbeddings(BACKFILL_BATCH);
  for (const e of missing) {
    await queue.enqueue({
      kind: 'mem-embed',
      priority: 'low',
      fingerprint: `backfill:${e.id}`,
      scheduledBy: 'periodic',
      payload: { kind: 'mem-embed', entryId: e.id, text: e.text },
    });
    enqueued++;
  }
  return enqueued;
}
