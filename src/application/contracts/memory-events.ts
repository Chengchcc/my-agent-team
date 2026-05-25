// ── memory.summary.ready ──────────────────────────────────────────────────────

export interface MemorySummaryReadyV1 {
  turnId: string;
  sessionId: string;
  summary: {
    text: string;
    weight: number;
    tags: string[];
  };
}

// ── memory.summarized ─────────────────────────────────────────────────────────

export interface MemorySummarizedV1 {
  turnId: string;
}

// ── memory.extract.started ──────────────────────────────────────────────────

export interface MemoryExtractStartedV1 {
  runId: string;
}

// ── memory.extract.completed ────────────────────────────────────────────────

export interface MemoryExtractCompletedV1 {
  runId: string;
  count: number;
}

// ── memory.extract.failed ───────────────────────────────────────────────────

export interface MemoryExtractFailedV1 {
  runId: string;
  message: string;
}

// ── memory.dedup ────────────────────────────────────────────────────────────

export interface MemoryDedupV1 {
  kind: 'exact' | 'semantic';
  existingId: string;
}

// ── memory.superseded ───────────────────────────────────────────────────────

export interface MemorySupersededV1 {
  oldId: string;
  newId: string;
  reason: string;
}

// ── memory.prune.applied ───────────────────────────────────────────────────

export interface MemoryPruneAppliedV1 {
  deletedCount: number;
  dryRun: boolean;
}
