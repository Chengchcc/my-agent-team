import type { MemoryStore } from './types';

export interface EmbedTask {
  entryId: string;
  text: string;
}

export interface RunnerOutcome {
  outcome: 'completed' | 'failed' | 'aborted';
  error?: string;
}

type StoreWithEmbedding = MemoryStore & {
  storeEmbedding?(entryId: string, embedding: number[]): Promise<void>;
};

export class EmbeddingTaskRunner {
  constructor(
    private encode: (text: string) => Promise<number[]>,
    private store: StoreWithEmbedding,
  ) {}

  async run(task: EmbedTask): Promise<RunnerOutcome> {
    try {
      const embedding = await this.encode(task.text);
      if (this.store.storeEmbedding) {
        await this.store.storeEmbedding(task.entryId, embedding);
      } else {
        await this.store.update(task.entryId, { embedding });
      }
      return { outcome: 'completed' };
    } catch (err) {
      return { outcome: 'failed', error: String(err) };
    }
  }
}
