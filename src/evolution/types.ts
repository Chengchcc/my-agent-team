import type { TraceRun } from '../trace/types';

/** Configuration for the background review system. */
export interface ReviewConfig {
  enabled: boolean;
  model: string;
  maxTurns: number;
  tokenLimit: number;
  timeoutMs: number;
  outputDir: string;
}

/** A completed review notification for TUI display. */
export interface ReviewNotification {
  skillName: string;
  description: string;
  outputDir: string;
  createdAt: number;
}

/** Callback type for wiring evolution into the trace middleware. */
export type EvolutionReviewCallback = (
  nudgeResult: { signal: string; trigger: string; traceRunId: string; sessionId: string; reason: string },
  trace: TraceRun,
) => void;
