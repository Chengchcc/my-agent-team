/** Core trace data model types for the middleware-based trace system. */

export interface TraceTurn {
  turnIndex: number;
  userMessage?: string;
  modelResponse?: {
    thinking?: string;
    text: string;
    toolCalls: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>;
    usage: Record<string, number>;
  };
  toolExecutions: Array<{
    toolName: string;
    success: boolean;
    durationMs: number;
    error?: string;
  }>;
  compaction?: {
    level: string;
    beforeTokens: number;
    afterTokens: number;
  };
}

export interface TraceSummary {
  totalTurns: number;
  totalToolCalls: number;
  totalErrors: number;
  totalTokens: Record<string, number>;
  outcome: 'completed' | 'error' | 'max_turns' | 'aborted';
  error?: string;
  activatedSkills?: string[];
}

export interface TraceRun {
  id: string;
  sessionId: string;
  parentRunId?: string | undefined;
  startTime: number;
  endTime: number;
  model: string;
  turns: TraceTurn[];
  summary: TraceSummary;
}

/** One line in the NDJSON file. */
export type TraceEntry =
  | ({ type: 'turn'; turnIndex: number } & TraceTurn)
  | ({ type: 'tool' } & TraceTurn['toolExecutions'][number])
  | ({ type: 'summary' } & TraceSummary);

export interface TraceRedactor {
  redactToolArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown>;
  redactText(text: string): string;
}

export interface NudgeState {
  turnsSinceReview: number;
  fingerprints: Record<string, string[]>;
  lastReviewAt: number;
  lastSignalAt: Record<string, number>;
}

export interface NudgeResult {
  trigger: 'memory_review' | 'skill_review' | 'combined_review';
  signal: 'error_burst' | 'complex_task' | 'periodic';
  traceRunId: string;
  sessionId: string;
  fingerprint: string;
  reason: string;
}

export interface TraceStore {
  appendTurn(runId: string, sessionId: string, entry: TraceEntry): Promise<void>;
  finalize(trace: TraceRun): Promise<void>;
  get(runId: string, sessionId: string): Promise<TraceRun | null>;
  listBySession(sessionId: string, limit?: number): Promise<string[]>;
  listRecent(sessionLimit?: number, runLimit?: number): Promise<TraceRun[]>;
}
