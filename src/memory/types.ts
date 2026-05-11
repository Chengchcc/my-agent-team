
export const MEMORY_TYPES = ['general'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  text: string;
  tags?: string[];
  created: string;
  updated?: string;
  weight: number;
  source: 'explicit' | 'implicit' | 'user';
  projectPath?: string;
  files?: string[];
  metadata?: Record<string, unknown>;
  /** Optional embedding vector for similarity-based deduplication. */
  embedding?: number[];
  /** Unix timestamp of last retrieval hit (for LRU eviction). */
  lastHitAt?: number;
  /** Number of times this entry has been used/recalled. */
  usageCount?: number;
}

export interface MemoryStore {
  add(entry: Omit<MemoryEntry, 'id' | 'created'>): Promise<MemoryEntry>;
  get(id: string): Promise<MemoryEntry | null>;
  update(id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry | null>;
  remove(id: string): Promise<boolean>;
  getAll(): Promise<MemoryEntry[]>;
  replaceAll(entries: MemoryEntry[], type: MemoryType): Promise<void>;
  count(type?: MemoryType): Promise<number>;
  getRecent(limit: number, type?: MemoryType): Promise<MemoryEntry[]>;
  /** Enforce capacity limit, evicting least-recently-used entries. */
  enforceLimit?(): Promise<void>;
  /** Mark entries as retrieved (updates lastHitAt for LRU tracking). */
  markHit?(ids: string[]): Promise<void>;
}

export interface MemoryRetriever {
  search(query: string, options?: { limit?: number; threshold?: number }): Promise<MemoryEntry[]>;
}
export interface MemoryExtractor {
  extract(traceContext: TraceExtractionContext): Promise<MemoryEntry[]>;
  consolidate(entries: MemoryEntry[]): Promise<MemoryEntry[]>;
}

export interface TraceExtractionContext {
  userTurns: Array<{ content: string }>;
  toolCalls: Array<{ tool: string; success: boolean; error?: string }>;
  outcomes: string[];
  totalTurns: number;
  totalErrors: number;
  activatedSkills?: string[];
}

export interface MemoryConfig {
  globalBaseDir?: string;
  maxGeneralEntries?: number;
  consolidationThreshold?: number;
  autoExtractMinToolCalls?: number;
  maxInjectedEntries?: number;
  extractionModel?: string;
  /** Minimum similarity score for memory retrieval (0-1). Results below this are filtered out. */
  retrievalThreshold?: number;
  /** Max general entries retrieved per query. */
  retrievalTopK?: number;
  /** Extraction trigger mode: 'explicit' = only on trigger words, 'auto' = on every task completion, 'off' = disabled. */
  extractTriggerMode?: 'explicit' | 'auto' | 'off';
  /** Max user preference entries (for system prompt). */
  maxUserPreferences?: number;
  /** Weight threshold for entries to be injected as user_preferences. */
  preferenceWeightThreshold?: number;
}

