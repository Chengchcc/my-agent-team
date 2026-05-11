import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'fs/promises';
import type { NudgeState, NudgeResult, TraceRun } from './types';

const MIN_REVIEW_INTERVAL_SECONDS = 30;
const MS_PER_SECOND = 1000;
const MIN_REVIEW_INTERVAL_MS = MIN_REVIEW_INTERVAL_SECONDS * MS_PER_SECOND;
const DEFAULT_REVIEW_INTERVAL = 10;
const ERROR_BURST_MIN_ERRORS = 2;
const ERROR_BURST_MIN_ERROR_RATIO = 0.3;
const COMPLEX_TASK_MIN_TURNS = 5;
const PERCENT_MULTIPLIER = 100;
const MAX_FINGERPRINTS_PER_SIGNAL = 50;
const TURN_BUCKET_SIZE = 5;
const FINGERPRINT_HASH_LENGTH = 16;

const MEMORY_WORTHY_MIN_TOOLS = 3;
const SECONDS_PER_MINUTE = 60;
const COOLDOWN_ERROR_BURST_MINUTES = 2;
const COOLDOWN_COMPLEX_TASK_MINUTES = 10;
const COOLDOWN_PERIODIC_MINUTES = 30;
const COOLDOWN_MEMORY_WORTHY_MINUTES = 10;
const SIGNAL_COOLDOWNS: Record<string, number> = {
  error_burst: COOLDOWN_ERROR_BURST_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND,
  complex_task: COOLDOWN_COMPLEX_TASK_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND,
  periodic: COOLDOWN_PERIODIC_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND,
  memory_worthy: COOLDOWN_MEMORY_WORTHY_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND,
};

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
    const now = Date.now();
    if (now - this.state.lastReviewAt < MIN_REVIEW_INTERVAL_MS) {
      return null;
    }

    const errorRatio = trace.summary.totalTurns > 0
      ? trace.summary.totalErrors / trace.summary.totalTurns
      : 0;

    // Signal 1: Error burst
    if (trace.summary.totalErrors >= ERROR_BURST_MIN_ERRORS && errorRatio >= ERROR_BURST_MIN_ERROR_RATIO) {
      if (!this.isOnCooldown('error_burst', now)) {
        const fp = this.buildFingerprint(trace);
        if (!this.isDuplicate('error_burst', fp)) {
          return this.emit('error_burst', trace, fp);
        }
      }
    }

    // Signal 2: Complex task
    if (trace.summary.totalTurns >= COMPLEX_TASK_MIN_TURNS && trace.summary.totalErrors === 0) {
      if (!this.isOnCooldown('complex_task', now)) {
        const fp = 'complex:' + this.buildFingerprint(trace);
        if (!this.isDuplicate('complex_task', fp)) {
          return this.emit('complex_task', trace, fp);
        }
      }
    }

    // Signal 3: Periodic
    this.state.turnsSinceReview += trace.summary.totalTurns;
    if (this.state.turnsSinceReview >= this.reviewInterval) {
      this.state.turnsSinceReview = 0;
      if (!this.isOnCooldown('periodic', now)) {
        const fp = this.buildFingerprint(trace);
        if (!this.isDuplicate('periodic', fp)) {
          return this.emit('periodic', trace, fp);
        }
      }
    }

    // Signal 4: Memory extraction — task completed, meaningful work done
    if (trace.summary.outcome === 'completed'
        && trace.summary.totalToolCalls >= MEMORY_WORTHY_MIN_TOOLS) {
      if (!this.isOnCooldown('memory_worthy', now)) {
        const fp = 'mem:' + this.buildFingerprint(trace);
        if (!this.isDuplicate('memory_worthy', fp)) {
          return this.emit('memory_worthy', trace, fp);
        }
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
    signal: NudgeResult['signal'],
    trace: TraceRun,
    fingerprint: string,
  ): NudgeResult {
    this.state.lastReviewAt = Date.now();
    if (!this.state.lastSignalAt) this.state.lastSignalAt = {};
    this.state.lastSignalAt[signal] = Date.now();
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
    if (signal === 'memory_worthy') return 'memory_extract';
    return 'skill_review';
  }

  private buildReason(signal: NudgeResult['signal'], trace: TraceRun): string {
    const e = trace.summary.totalErrors;
    const t = trace.summary.totalTurns;
    switch (signal) {
      case 'error_burst':
        return `${e} errors in ${t} turns (error rate: ${Math.round((e / t) * PERCENT_MULTIPLIER)}%) — review for failure patterns`;
      case 'complex_task':
        return `${t}-turn task completed successfully — candidate for skill extraction`;
      case 'periodic':
        return `Periodic review after ${this.reviewInterval} accumulated turns`;
      case 'memory_worthy':
        return `${trace.summary.totalToolCalls} tool calls in ${t} turns completed — extract memories`;
    }
  }

  private buildFingerprint(trace: TraceRun): string {
    const errorTools = new Set<string>();
    for (const turn of trace.turns) {
      for (const exec of turn.toolExecutions) {
        if (!exec.success) errorTools.add(exec.toolName);
      }
    }
    const sortedTools = [...errorTools].sort().join(',') || 'no_errors';
    const turnBucket = Math.floor(trace.summary.totalTurns / TURN_BUCKET_SIZE);
    const sortedSkills = [...(trace.summary.activatedSkills ?? [])].sort().join(',') || 'none';
    const raw = `${sortedTools}:${turnBucket}:${sortedSkills}`;
    return createHash('sha1').update(raw).digest('hex').slice(0, FINGERPRINT_HASH_LENGTH);
  }

  private isDuplicate(signal: string, fp: string): boolean {
    return (this.state.fingerprints[signal] ?? []).includes(fp);
  }

  private isOnCooldown(signal: string, now: number): boolean {
    const lastAt = this.state.lastSignalAt?.[signal] ?? 0;
    const cooldown = SIGNAL_COOLDOWNS[signal] ?? MIN_REVIEW_INTERVAL_MS;
    return now - lastAt < cooldown;
  }

  private recordFingerprint(signal: string, fp: string): void {
    const list = this.state.fingerprints[signal] ?? [];
    list.unshift(fp);
    this.state.fingerprints[signal] = list.slice(0, MAX_FINGERPRINTS_PER_SIGNAL);
  }

  private defaultState(): NudgeState {
    return {
      turnsSinceReview: 0,
      fingerprints: { error_burst: [], complex_task: [], periodic: [], memory_worthy: [] },
      lastReviewAt: 0,
      lastSignalAt: {},
    };
  }

  private loadState(): void {
    try {
      if (existsSync(this.statePath)) {
        const raw = readFileSync(this.statePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<NudgeState>;
        this.state = { ...this.defaultState(), ...parsed };
        if (!this.state.lastSignalAt) this.state.lastSignalAt = {};
      }
    } catch {
      this.state = this.defaultState();
    }
  }
}
