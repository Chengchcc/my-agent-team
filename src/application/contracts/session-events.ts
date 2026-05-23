// ── session.created ───────────────────────────────────────────────────────────

export interface SessionCreatedV1 {
  id: string;
  title: string;
  agentId?: string;
  isMain?: boolean;
}

// ── turn.started ──────────────────────────────────────────────────────────────

export interface TurnStartedV1 {
  sessionId: string;
  turnId: string;
}

// ── turn.completed ────────────────────────────────────────────────────────────

export interface TurnCompletedV1 {
  sessionId: string;
  turnId: string;
  runId: string;
  usage: { input: number; output: number };
  toolCallCount: number;
  toolErrorCount: number;
  activatedSkills: string[];
}

// ── turn.failed ───────────────────────────────────────────────────────────────

export interface TurnFailedV1 {
  sessionId: string;
  turnId: string;
  runId: string;
  outcome: 'error' | 'aborted' | 'max_turns' | 'network_error';
  stage: string;
  reason: string;
  toolErrorCount: number;
}

// ── session.compacted ──────────────────────────────────────────────────────────

export interface SessionCompactedV1 {
  sessionId: string
  removedCount: number
  summaryRecordId: string
  usage: { input: number; output: number }
  ts: number
}
