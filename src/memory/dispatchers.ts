import type { Provider } from '../types';
import type { MemoryStore, TraceExtractionContext } from './types';
import type { EvolutionTask } from '../evolution/persistent-queue';
import type { RunnerContext } from '../evolution/review-runner';
import type { TraceStore } from '../trace/types';
import { LlmExtractor } from './extractor';

interface MemDispatchDeps {
  provider: Provider;
  generalStore: MemoryStore;
  traceStore: TraceStore;
  enqueueEmbed: (entryId: string, text: string) => Promise<void>;
  embeddingRunner?: {
    run(task: { entryId: string; text: string }): Promise<{ outcome: string }>;
  };
}

export function createMemExtractDispatcher(deps: MemDispatchDeps) {
  return async (task: EvolutionTask, _ctx: RunnerContext): Promise<void> => {
    const payload = task.payload as { kind: 'mem-extract'; traceId: string; projectPath: string };

    const trace = await deps.traceStore.get(payload.traceId, '');
    if (!trace) {
      throw new Error(`Trace ${payload.traceId} not found`);
    }

    const context: TraceExtractionContext = {
      userTurns: trace.turns
        .filter(t => t.userMessage)
        .map(t => ({ content: t.userMessage! })),
      toolCalls: trace.turns.flatMap(t =>
        t.toolExecutions.map(te => ({
          tool: te.toolName,
          success: te.success,
          ...(te.error ? { error: te.error } : {}),
        })),
      ),
      outcomes: extractOutcomes(trace),
      totalTurns: trace.turns.length,
      totalErrors: trace.summary.totalErrors,
      ...(trace.summary.activatedSkills ? { activatedSkills: trace.summary.activatedSkills } : {}),
    };

    const extractor = new LlmExtractor(deps.provider);
    const entries = await extractor.extract(context);

    for (const entry of entries) {
      const stored = await deps.generalStore.add(entry);
      await deps.enqueueEmbed(stored.id, stored.text);
    }

    await deps.generalStore.enforceLimit?.();
  };
}

export function createMemEmbedDispatcher(
  runner: { run(task: { entryId: string; text: string }): Promise<{ outcome: string }> },
) {
  return async (task: EvolutionTask, _ctx: RunnerContext): Promise<void> => {
    const payload = task.payload as { kind: 'mem-embed'; entryId: string; text: string };
    const result = await runner.run(payload);
    if (result.outcome === 'failed') {
      throw new Error('Embedding failed');
    }
  };
}

function extractOutcomes(trace: { summary: { outcome: string; error?: string } }): string[] {
  const outcomes: string[] = [];
  if (trace.summary.outcome) outcomes.push(`Session outcome: ${trace.summary.outcome}`);
  if (trace.summary.error) outcomes.push(`Error: ${trace.summary.error}`);
  return outcomes;
}
