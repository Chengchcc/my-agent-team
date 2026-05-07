import type { ReviewConfig } from './types';
import type { Provider } from '../types';
import { forkReviewAgent } from './review-agent';
import type { TraceRun } from '../trace/types';
import { debugLog } from '../utils/debug';
import os from 'os';
import path from 'path';

export interface EvolutionModule {
  review: (
    nudgeResult: { signal: string; trigger: string; traceRunId: string; sessionId: string; reason: string },
    trace: TraceRun,
  ) => void;
  outputDir: string;
}

type TriggerType = 'error_burst' | 'complex_task' | 'periodic';

function isValidTrigger(value: string): value is TriggerType {
  return value === 'error_burst' || value === 'complex_task' || value === 'periodic';
}

export function initEvolution(
  config: ReviewConfig,
  provider: Provider,
  onSkillCreated?: ((skillName: string, description: string, outputDir: string) => void) | undefined,
): EvolutionModule | null {
  if (!config.enabled) return null;

  const outputDir = config.outputDir.startsWith('~')
    ? path.join(os.homedir(), config.outputDir.slice(1))
    : config.outputDir;

  let isReviewRunning = false;

  return {
    outputDir,
    review(nudgeResult, trace) {
      // Concurrency guard: one review at a time
      if (isReviewRunning) {
        debugLog('[evolution] Review skipped — another review is already running');
        return;
      }

      const signal = nudgeResult.signal;
      if (!isValidTrigger(signal)) {
        debugLog(`[evolution] Unknown signal: ${signal}`);
        return;
      }

      isReviewRunning = true;

      forkReviewAgent(signal, trace, {
        outputDir,
        provider,
        model: config.model,
        maxTurns: config.maxTurns,
        tokenLimit: config.tokenLimit,
        timeoutMs: config.timeoutMs,
        onSkillCreated,
        onComplete: () => {
          isReviewRunning = false;
        },
      });
    },
  };
}

// Re-export for consumers
export { CreateReviewSkillTool } from './review-tools';
export { forkReviewAgent, buildReviewSystemPrompt } from './review-agent';
export type { ReviewConfig, ReviewNotification, EvolutionReviewCallback } from './types';
