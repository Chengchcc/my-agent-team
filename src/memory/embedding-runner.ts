import type { MemoryStore } from './types';

export interface EmbedTask {
  entryId: string;
  text: string;
  storeType: 'semantic' | 'episodic' | 'project';
}

export interface RunnerOutcome {
  outcome: 'completed' | 'failed' | 'aborted';
  error?: string;
}

export class EmbeddingTaskRunner {
  constructor(
    private encode: (text: string) => Promise<number[]>,
    private semanticStore: MemoryStore,
    private episodicStore: MemoryStore,
    private projectStore: MemoryStore,
  ) {}

  async run(task: EmbedTask): Promise<RunnerOutcome> {
    try {
      const embedding = await this.encode(task.text);
      const store = this.getStore(task.storeType);
      await store.update(task.entryId, { embedding });
      return { outcome: 'completed' };
    } catch (err) {
      return { outcome: 'failed', error: String(err) };
    }
  }

  private getStore(type: string): MemoryStore {
    switch (type) {
      case 'semantic': return this.semanticStore;
      case 'episodic': return this.episodicStore;
      default: return this.projectStore;
    }
  }
}
