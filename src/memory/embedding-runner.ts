import type { MemoryStore } from './types';

export interface EmbedTask {
  entryId: string;
  text: string;
}

export interface RunnerOutcome {
  outcome: 'completed' | 'failed' | 'aborted';
  error?: string;
}

export class EmbeddingTaskRunner {
  constructor(
    private encode: (text: string) => Promise<number[]>,
    private generalStore: MemoryStore,
  ) {}

  async run(task: EmbedTask): Promise<RunnerOutcome> {
    try {
      const embedding = await this.encode(task.text);
      await this.generalStore.update(task.entryId, { embedding });
      return { outcome: 'completed' };
    } catch (err) {
      return { outcome: 'failed', error: String(err) };
    }
  }
}
