import type { ReviewConfig } from './types';
import type { Provider } from '../types';
import { forkReviewAgent } from './review-agent';
import { EffectivenessTracker } from './effectiveness-tracker';
import { forkSkillAnalysis, buildAnalysisPrompt, verdictToEvalCase, type TraceSnippet } from './skill-analyzer';
import type { TraceRun, TraceSummary, TraceStore } from '../trace/types';
import { debugLog } from '../utils/debug';
import { IdleGate } from './idle-gate';
import { ReviewSlot, signalPriority } from './review-slot';
import { ReviewBackoff } from './review-backoff';
import { TaskRunner, type RunnerOutcome } from './review-runner';
import { PersistentQueue, type TriggerSource, type EvolutionTaskKind } from './persistent-queue';
import { TierBreaker } from './tier-breaker';
import { Drainer } from './drainer';
import { SettleBus } from './settle-bus';
import { startAllTriggers } from './triggers';
import os from 'os';
import path from 'path';

const DEFAULT_AUTO_ACCEPT_HOURS = 48;
const DEFAULT_REVIEW_INTERVAL = 10;
const FEEDBACK_CASES_NOTIFY_THRESHOLD = 5;
const REASONING_PREVIEW_LENGTH = 80;
const TIER2_RECENT_SESSION_LIMIT = 5;
const TIER2_RECENT_RUN_LIMIT = 3;

export interface EvolutionModule {
  review: (
    nudgeResult: { signal: string; trigger: string; traceRunId: string; sessionId: string; fingerprint: string; reason: string },
    trace: TraceRun,
  ) => void;
  trackStats: (summary: TraceSummary, runId: string) => Promise<Array<{ skillName: string; triggerReview: boolean }>>;
  autoAcceptStaleSkills: () => Promise<string[]>;
  runTier2Analysis: (skillName: string, description: string) => void;
  drainQueue: () => Promise<number>;
  recoverInflight: () => Promise<string[]>;
  outputDir: string;
  idleGate: IdleGate;
  settleBus: SettleBus;
  manualTrigger: { fire: (kinds?: EvolutionTaskKind[]) => void };
}

type TriggerType = 'error_burst' | 'complex_task' | 'periodic';

function isValidTrigger(value: string): value is TriggerType {
  return value === 'error_burst' || value === 'complex_task' || value === 'periodic';
}

function createTier2Handler(
  tracker: EffectivenessTracker,
  store: TraceStore | undefined,
  provider: Provider,
  model: string,
  notify: ((skillName: string, description: string, outputDir: string) => void) | undefined,
  outputDir: string,
  feedbackCases: { value: number },
) {
  return (skillName: string, description: string) => {
    void (async () => {
      const status = await tracker.loadStatus(skillName);
      const stats = status?.stats ?? { totalRuns: 0, successfulRuns: 0, successRate: 0, lastRunId: '' };

      let traces: TraceSnippet[] = [];
      if (store) {
        try {
          const recentRuns = await store.listRecent(TIER2_RECENT_SESSION_LIMIT, TIER2_RECENT_RUN_LIMIT);
          traces = recentRuns
            .filter(r => r.summary.activatedSkills?.includes(skillName))
            .map(r => ({
              outcome: r.summary.outcome,
              traces: `Turns: ${r.summary.totalTurns}, Errors: ${r.summary.totalErrors}, ` +
                r.turns.map((t, i) => `Turn ${i}: ${t.toolExecutions.map(e => `${e.toolName}(${e.success ? 'ok' : 'fail'})`).join(', ')}`).join(' | '),
            }));
        } catch { /* best-effort */ }
      }

      const prompt = buildAnalysisPrompt(skillName, description, stats, traces);
      forkSkillAnalysis(prompt, provider, model, (verdict) => { void (async () => {
        if (verdict) {
          const currentStatus = await tracker.loadStatus(skillName);
          if (currentStatus) {
            currentStatus.status = 'reviewed';
            await tracker.saveStatus(currentStatus);
          }
          if (verdict.verdict === 'fix') {
            notify?.(skillName, `Analysis: skill needs adjustment — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}... [/review view ${skillName}]`, outputDir);
          } else if (verdict.verdict === 'delete') {
            notify?.(skillName, `Marked as harmful — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}... [/review delete ${skillName}]`, outputDir);
          }
          const evalCase = verdictToEvalCase(skillName, verdict);
          if (evalCase) {
            try {
              await tracker.appendFeedbackEval(skillName, JSON.stringify(verdict));
              feedbackCases.value++;
              if (feedbackCases.value >= FEEDBACK_CASES_NOTIFY_THRESHOLD) {
                debugLog(`[evolution] ${feedbackCases.value} feedback cases pending for prompt optimization`);
                notify?.('prompt-optimization', `${feedbackCases.value} feedback cases pending — run /review optimize to improve review prompts`, outputDir);
              }
            } catch (err) {
              debugLog(`[evolution] Failed to append feedback: ${err}`);
            }
          }
        }
      })(); });
    })();
  };
}

export function initEvolution(
  config: ReviewConfig,
  provider: Provider,
  notify?: (skillName: string, description: string, outputDir: string) => void,
  store?: TraceStore,
  reviewInterval?: number,
): EvolutionModule | null {
  if (!config.enabled) return null;

  const outputDir = config.outputDir.startsWith('~')
    ? path.join(os.homedir(), config.outputDir.slice(1))
    : config.outputDir;

  const feedbackCases = { value: 0 };
  const tracker = new EffectivenessTracker(outputDir);
  const effectiveReviewInterval = reviewInterval ?? DEFAULT_REVIEW_INTERVAL;
  const idleGate = new IdleGate();
  const slot = new ReviewSlot();
  const tierBreaker = new TierBreaker();
  const backoff = new ReviewBackoff();
  const runner = new TaskRunner();
  const queue = new PersistentQueue();
  const drainer = new Drainer(queue, tierBreaker, idleGate);
  const settleBus = new SettleBus();
  drainer.setSettleBus(settleBus);

  // Wire dispatchers per task kind
  drainer.setDispatcher('tier0_review', async (task) => {
    await new Promise<void>((resolve, reject) => {
      if (task.payload.kind !== 'tier0_review') { resolve(); return; }
      const sig = task.payload.signal as TriggerType;
      forkReviewAgent(sig, task.payload.trace, {
        outputDir, provider, model: config.model, maxTurns: config.maxTurns,
        tokenLimit: config.tokenLimit, timeoutMs: config.timeoutMs,
        onSkillCreated: notify, onComplete: resolve, onError: () => reject(new Error('review failed')),
        ...(store ? { store } : {}), ...(effectiveReviewInterval ? { reviewInterval: effectiveReviewInterval } : {}),
      });
    });
  });
  drainer.setDispatcher('tier2_verdict', async (task) => {
    if (task.payload.kind !== 'tier2_verdict') return;
    const { skillName, description, skillStats } = task.payload;
    const prompt = buildAnalysisPrompt(skillName, description, skillStats, []);
    await new Promise<void>((resolve) => {
      forkSkillAnalysis(prompt, provider, config.model, (verdict) => {
        if (verdict) {
          debugLog(`[tier2] Verdict for ${skillName}: ${verdict.verdict} — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}`);
          tracker.saveStatus({ skillName, status: 'reviewed', createdAt: Date.now(), sourceRunId: task.payload.traceRunId });
          if (verdict.verdict === 'fix') {
            notify?.(skillName, `Tier2: needs adjustment — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}`, outputDir);
          } else if (verdict.verdict === 'delete') {
            notify?.(skillName, `Tier2: marked as harmful — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}`, outputDir);
          }
        }
        resolve();
      });
    });
    // Derive Tier 0 if verdict is 'edit'
    // queue.deriveTask(task, 'tier0_review', ...) — Phase F guard
  });
  drainer.setDispatcher('tier3_prompt_opt', async (task) => {
    if (task.payload.kind !== 'tier3_prompt_opt') return;
    debugLog(`[tier3opt] Prompt optimization for ${task.payload.promptKey} — pipeline stub (Phase F)`);
    // Phase F full: read feedback → build optimizer prompt → fork agent → write candidate → derive tier3_ab
  });
  drainer.setDispatcher('tier3_ab_promote', async (task) => {
    if (task.payload.kind !== 'tier3_ab_promote') return;
    debugLog(`[tier3ab] AB promote check for ${task.payload.candidateId} — pipeline stub (Phase F)`);
    // Phase F full: read shadow metrics → compare → promote to prompt-templates.ts or reject
  });
  drainer.setDispatcher('auto_accept_sweep', async () => {
    const accepted = await tracker.autoAcceptStaleSkills(config.autoAcceptHours ?? DEFAULT_AUTO_ACCEPT_HOURS);
    if (accepted.length > 0) {
      debugLog(`[evolution] Auto-accepted ${accepted.length} stale skills: ${accepted.join(', ')}`);
      for (const skillName of accepted) notify?.(skillName, 'Auto-accepted after 48h', outputDir);
    }
  });

  // Start triggers
  const triggers = startAllTriggers(idleGate, settleBus, (opts) => drainer.tryDrain(opts), queue);

  const runTier0 = (signal: string, trace: TraceRun, onComplete: () => void, onError: () => void) => {
    runner.run(
      () => new Promise<RunnerOutcome>((resolve, reject) => {
        forkReviewAgent(signal as TriggerType, trace, {
          outputDir, provider, model: config.model, maxTurns: config.maxTurns,
          tokenLimit: config.tokenLimit, timeoutMs: config.timeoutMs,
          onSkillCreated: notify,
          onComplete: () => resolve({ result: 'success' }),
          onError: () => reject(new Error('review failed')),
          ...(store ? { store } : {}), ...(effectiveReviewInterval ? { reviewInterval: effectiveReviewInterval } : {}),
        });
      }),
      { onComplete: (_outcome) => { onComplete(); }, onError: (_err) => { onError(); } },
    );
  };

  const enqueueBlocked = (signal: string, nr: { trigger: string; sessionId: string; traceRunId: string; fingerprint: string; reason: string }, trace: TraceRun) => {
    if (!isValidTrigger(signal)) return;
    queue.enqueue({
      kind: 'tier0_review', priority: 'high', fingerprint: nr.fingerprint,
      scheduledBy: signal as TriggerSource,
      payload: { kind: 'tier0_review', sessionId: nr.sessionId, runId: nr.traceRunId, signal, trace },
    }).catch(() => {});
  };

  return {
    outputDir,
    review(nudgeResult: { signal: string; trigger: string; traceRunId: string; sessionId: string; fingerprint: string; reason: string }, trace: TraceRun) {
      const signal = nudgeResult.signal;
      if (!isValidTrigger(signal)) { debugLog(`[evolution] Unknown signal: ${signal}`); return; }

      if (!backoff.canRun()) {
        debugLog('[evolution] Review blocked by backoff — enqueuing');
        enqueueBlocked(signal, nudgeResult, trace); return;
      }
      if (!tierBreaker.canRun('tier0_review')) {
        debugLog('[evolution] Review blocked by TierBreaker(tier0) — enqueuing');
        enqueueBlocked(signal, nudgeResult, trace); return;
      }
      if (!idleGate.canRun()) {
        enqueueBlocked(signal, nudgeResult, trace);
        debugLog(`[evolution] Enqueued ${signal} review (system busy)`); return;
      }
      if (slot.running) {
        const task = { signal, priority: signalPriority(signal), nudgeResult, trace };
        if (slot.tryEnqueue(task)) { debugLog('[evolution] Queued (higher priority)'); }
        else { debugLog('[evolution] Skipped — lower priority'); }
        return;
      }

      slot.tryEnqueue({ signal, priority: signalPriority(signal), nudgeResult, trace });
      slot.markRunning();
      runTier0(signal, trace,
        () => { slot.markDone(); backoff.recordSuccess(); tierBreaker.recordSuccess('tier0_review'); },
        () => { backoff.recordFailure(); tierBreaker.recordFailure('tier0_review'); },
      );
    },
    idleGate,
    settleBus,
    manualTrigger: triggers.manual,
    async trackStats(summary, runId) {
      const results: Array<{ skillName: string; triggerReview: boolean }> = [];
      if (!summary.activatedSkills || summary.activatedSkills.length === 0) {
        return results;
      }
      for (const skillName of summary.activatedSkills) {
        try {
          const stats = await tracker.updateStats(skillName, summary.outcome, runId);
          const triggerReview = tracker.shouldTriggerReview(stats);
          results.push({ skillName, triggerReview });
          if (triggerReview) {
            debugLog(`[evolution] Low score for ${skillName}: ${stats.successRate.toFixed(2)} (${stats.successfulRuns}/${stats.totalRuns}) — Tier 2 review recommended`);
          }
        } catch (err) {
          debugLog(`[evolution] Failed to update stats for ${skillName}: ${err}`);
        }
      }
      return results;
    },
    autoAcceptStaleSkills: () => tracker.autoAcceptStaleSkills(config.autoAcceptHours ?? DEFAULT_AUTO_ACCEPT_HOURS),

    runTier2Analysis: createTier2Handler(
      tracker, store, provider, config.model, notify, outputDir,
      feedbackCases,
    ),

    async drainQueue() { return drainer.tryDrain(); },
    recoverInflight: () => queue.recoverInflight(),
  };
}

// Re-export for consumers
export { CreateReviewSkillTool } from './review-tools';
export { forkReviewAgent, buildReviewSystemPrompt } from './review-agent';
export { EffectivenessTracker } from './effectiveness-tracker';
export { IdleGate } from './idle-gate';
export { ReviewSlot, signalPriority } from './review-slot';
export type { PendingReview } from './review-slot';
export { CircuitBreaker } from './circuit-breaker';
export { TierBreaker } from './tier-breaker';
export { ReviewBackoff } from './review-backoff';
export { TaskRunner } from './review-runner';
export type { RunnerContext } from './review-runner';
export { PersistentQueue } from './persistent-queue';
export type { EvolutionTaskKind, EvolutionTask, TaskPayload, QueuePriority, TriggerSource } from './persistent-queue';
export { Drainer } from './drainer';
export { SettleBus } from './settle-bus';
export type { SettleEvent } from './settle-bus';
export { Supervisor } from './supervisor';
export { startAllTriggers, createManualTrigger, createIdleTrigger, createEventTrigger, createCronTriggers, createThresholdTrigger } from './triggers';
export type { Trigger } from './triggers';
export type { ReviewConfig, ReviewNotification, EvolutionCallback, SkillStats, SkillStatus } from './types';
