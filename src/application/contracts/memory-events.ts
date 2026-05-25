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

// ── memory.remember.created ─────────────────────────────────────────────────

export interface RememberCreatedV1 {
  id: string;
  text: string;
  type: string;
  source: 'explicit';
}

// ── memory.remember.merged ──────────────────────────────────────────────────

export interface RememberMergedV1 {
  existingId: string;
  candidateText: string;
}

// ── memory.remember.rejected ────────────────────────────────────────────────

export interface RememberRejectedV1 {
  reason: string;
  redactedText: string;
}

// ── memory.forget.soft ─────────────────────────────────────────────────────

export interface ForgetSoftV1 {
  ids: string[];
  tombstoneId: string;
  query: string;
}

// ── memory.forget.hard ─────────────────────────────────────────────────────

export interface ForgetHardV1 {
  ids: string[];
  query: string;
}

// ── memory.prune.applied ───────────────────────────────────────────────────

export interface MemoryPruneAppliedV1 {
  deletedCount: number;
  dryRun: boolean;
}
