import type { Database } from 'bun:sqlite'
import { SqliteMemoryStore } from './sqlite-memory-store';
import type { MemoryStore } from '../../application/ports/memory-store';

export function createSqliteMemoryStore(db: Database): MemoryStore {
  return new SqliteMemoryStore(db);
}

