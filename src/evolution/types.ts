import type { TraceRun } from '../trace/types';

/** Configuration for the background review system. */
export interface ReviewConfig {
  enabled: boolean;
  model: string;
  maxTurns: number;
  tokenLimit: number;
  timeoutMs: number;
  outputDir: string;
  autoAcceptHours?: number;
  lowScoreWarningThreshold?: number;
}

/** A completed review notification for TUI display. */
export interface ReviewNotification {
  skillName: string;
  description: string;
  outputDir: string;
  createdAt: number;
}

/** Interface for the evolution module wired into trace middleware. */
export interface EvolutionCallback {
  review(
    nudgeResult: { signal: string; trigger: string; traceRunId: string; sessionId: string; reason: string },
    trace: TraceRun,
  ): void;
  trackStats(summary: TraceRun['summary'], runId: string): Promise<Array<{ skillName: string; triggerReview: boolean }>>;
  autoAcceptStaleSkills?(): Promise<string[]>;
}

/** Mechanical scoring data for a skill (Tier 1). */
export interface SkillStats {
  totalRuns: number;
  successfulRuns: number;
  successRate: number;
  lastRunId: string;
}

/** Persistent status of a skill in the evolution system. */
export interface SkillStatus {
  skillName: string;
  status: 'pending' | 'kept' | 'deleted' | 'reviewed';
  createdAt: number;
  sourceRunId: string;
  stats?: SkillStats;
}
