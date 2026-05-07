import { existsSync, readFileSync } from 'node:fs';
import fs from 'fs/promises';
import type { NudgeState, NudgeResult, TraceRun } from './types';

const MIN_REVIEW_INTERVAL_MINUTES = 5;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MIN_REVIEW_INTERVAL_MS =
  MIN_REVIEW_INTERVAL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
const DEFAULT_REVIEW_INTERVAL = 10;
const ERROR_BURST_MIN_ERRORS = 2;
const ERROR_BURST_MIN_ERROR_RATIO = 0.3;
const COMPLEX_TASK_MIN_TURNS = 5;
const PERCENT_MULTIPLIER = 100;
const MAX_FINGERPRINTS_PER_SIGNAL = 5;

export class NudgeEngine {
  private state: NudgeState;
  private reviewInterval: number;
  private statePath: string;

  constructor(statePath: string, reviewInterval: number = DEFAULT_REVIEW_INTERVAL) {
    this.statePath = statePath;
    this.reviewInterval = reviewInterval;
    this.state = this.defaultState();
    this.loadState();
  }

  tick(trace: TraceRun): NudgeResult | null {
    if (Date.now() - this.state.lastReviewAt < MIN_REVIEW_INTERVAL_MS) {
      return null;
    }

    const errorRatio = trace.summary.totalTurns > 0
      ? trace.summary.totalErrors / trace.summary.totalTurns
      : 0;

    // Signal 1: Error burst
    if (trace.summary.totalErrors >= ERROR_BURST_MIN_ERRORS && errorRatio >= ERROR_BURST_MIN_ERROR_RATIO) {
      const fp = this.buildFingerprint(trace);
      if (!this.isDuplicate('error_burst', fp)) {
        return this.emit('error_burst', trace, fp);
      }
    }

    // Signal 2: Complex task
    if (trace.summary.totalTurns >= COMPLEX_TASK_MIN_TURNS && trace.summary.totalErrors === 0) {
      const fp = 'complex:' + this.buildFingerprint(trace);
      if (!this.isDuplicate('complex_task', fp)) {
        return this.emit('complex_task', trace, fp);
      }
    }

    // Signal 3: Periodic
    this.state.turnsSinceReview += trace.summary.totalTurns;
    if (this.state.turnsSinceReview >= this.reviewInterval) {
      this.state.turnsSinceReview = 0;
      const fp = this.buildFingerprint(trace);
      if (!this.isDuplicate('periodic', fp)) {
        return this.emit('periodic', trace, fp);
      }
    }

    return null;
  }

  async persist(): Promise<void> {
    try {
      await fs.mkdir(this.statePath.substring(0, this.statePath.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(this.statePath, JSON.stringify(this.state), 'utf-8');
    } catch {
      // Best-effort persist
    }
  }

  private emit(
    signal: 'error_burst' | 'complex_task' | 'periodic',
    trace: TraceRun,
    fingerprint: string,
  ): NudgeResult {
    this.state.lastReviewAt = Date.now();
    this.recordFingerprint(signal, fingerprint);
    return {
      signal,
      trigger: this.signalToTrigger(signal, trace),
      traceRunId: trace.id,
      sessionId: trace.sessionId,
      fingerprint: `${signal}:${fingerprint}`,
      reason: this.buildReason(signal, trace),
    };
  }

  private signalToTrigger(
    signal: string,
    trace: TraceRun,
  ): NudgeResult['trigger'] {
    if (signal === 'error_burst' && trace.summary.totalTurns >= COMPLEX_TASK_MIN_TURNS) {
      return 'combined_review';
    }
    if (signal === 'error_burst') return 'memory_review';
    return 'skill_review';
  }

  private buildReason(signal: 'error_burst' | 'complex_task' | 'periodic', trace: TraceRun): string {
    const e = trace.summary.totalErrors;
    const t = trace.summary.totalTurns;
    switch (signal) {
      case 'error_burst':
        return `${e} errors in ${t} turns (error rate: ${Math.round((e / t) * PERCENT_MULTIPLIER)}%) — review for failure patterns`;
      case 'complex_task':
        return `${t}-turn task completed successfully — candidate for skill extraction`;
      case 'periodic':
        return `Periodic review after ${this.reviewInterval} accumulated turns`;
    }
  }

  private buildFingerprint(trace: TraceRun): string {
    const errorTools = new Set<string>();
    for (const turn of trace.turns) {
      for (const exec of turn.toolExecutions) {
        if (!exec.success) errorTools.add(exec.toolName);
      }
    }
    return [...errorTools].sort().join(',') || 'no_errors';
  }

  private isDuplicate(signal: string, fp: string): boolean {
    return (this.state.fingerprints[signal] ?? []).includes(fp);
  }

  private recordFingerprint(signal: string, fp: string): void {
    const list = this.state.fingerprints[signal] ?? [];
    list.unshift(fp);
    this.state.fingerprints[signal] = list.slice(0, MAX_FINGERPRINTS_PER_SIGNAL);
  }

  private defaultState(): NudgeState {
    return {
      turnsSinceReview: 0,
      fingerprints: { error_burst: [], complex_task: [], periodic: [] },
      lastReviewAt: 0,
    };
  }

  private loadState(): void {
    try {
      if (existsSync(this.statePath)) {
        const raw = readFileSync(this.statePath, 'utf-8');
        this.state = { ...this.defaultState(), ...JSON.parse(raw) };
      }
    } catch {
      this.state = this.defaultState();
    }
  }
}
