import { SqliteMemoryStore } from './sqlite-memory-store';
import type { MemoryStore } from '../../application/ports/memory-store';

export function createSqliteMemoryStore(opts: {
  agentId: string;
  baseDir: string;
}): MemoryStore {
  return new SqliteMemoryStore(opts.baseDir);
}

