import type { SkillStats } from './types';
import type { Provider } from '../types';
import { Agent } from '../agent/Agent';
import { ContextManager } from '../agent/context';
import { debugLog } from '../utils/debug';

export interface TraceSnippet {
  outcome: string;
  traces: string;
}

interface AnalysisVerdict {
  verdict: 'keep' | 'fix' | 'delete';
  reasoning: string;
  suggestion?: string;
}

export function buildAnalysisPrompt(
  skillName: string,
  description: string,
  stats: SkillStats,
  traces: TraceSnippet[],
): string {
  const traceSections = traces.map((t, i) =>
    `Trace ${i + 1} (outcome: ${t.outcome}):\n${t.traces}\n`,
  ).join('\n---\n');

  return `You are evaluating the effectiveness of an auto-generated skill.

Skill: ${skillName}
Description: ${description}
Success rate: ${stats.successRate.toFixed(2)} (${stats.successfulRuns}/${stats.totalRuns})

Related traces (runs where this skill was active):

${traceSections}

For each run where the outcome was "error", determine:
1. Was the skill's advice directly responsible for the error?
2. Was the error caused by external factors (API error, network, user interruption)?
3. Was the skill irrelevant to the task (present but unused)?

Overall assessment:
- "keep" — skill is useful, failures are unrelated
- "fix" — skill has specific issues (specify what to change)
- "delete" — skill is harmful or never useful

Output as JSON: {"verdict":"keep|fix|delete","reasoning":"...","suggestion":"..."}`;
}

export function parseVerdict(raw: string): AnalysisVerdict | null {
  try {
    const parsed = JSON.parse(raw) as AnalysisVerdict;
    if (!['keep', 'fix', 'delete'].includes(parsed.verdict)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function verdictToEvalCase(
  skillName: string,
  verdict: AnalysisVerdict,
): { query: string; should_trigger: boolean; expected_behavior: string } | null {
  if (verdict.verdict !== 'fix' || !verdict.suggestion) return null;
  return {
    query: `Analyze this trace where skill "${skillName}" was used. ${verdict.reasoning}`,
    should_trigger: true,
    expected_behavior: verdict.suggestion,
  };
}

const TIER2_MAX_TURNS = 4;
const TIER2_TOKEN_LIMIT = 20_000;
const TIER2_TIMEOUT_MS = 30_000;
const REASONING_PREVIEW_LENGTH = 100;

/**
 * Fork a lightweight analysis agent for Tier 2 skill review.
 * Fire-and-forget — results are delivered via onComplete callback.
 */
export function forkSkillAnalysis(
  prompt: string,
  provider: Provider,
  _model: string,
  onComplete: (verdict: AnalysisVerdict | null) => void,
): void {
  void (async () => {
    try {
      const agent = new Agent({
        provider,
        contextManager: new ContextManager({
          tokenLimit: TIER2_TOKEN_LIMIT,
          defaultSystemPrompt: `${prompt}\n\nRespond ONLY with the JSON verdict. No other text.`,
        }),
        toolRegistry: new (await import('../agent/tool-registry').then(m => m.ToolRegistry))(),
        config: { tokenLimit: TIER2_TOKEN_LIMIT },
        hooks: {},
        toolMiddlewares: [],
      });

      let responseText = '';
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Tier 2 analysis timeout')), TIER2_TIMEOUT_MS),
      );

      await Promise.race([
        (async () => {
          for await (const event of agent.runAgentLoop(
            { role: 'user', content: 'Analyze the skill effectiveness and output your JSON verdict.' },
            { maxTurns: TIER2_MAX_TURNS, timeoutMs: TIER2_TIMEOUT_MS },
          )) {
            if (event.type === 'text_delta') {
              responseText += event.delta;
            }
          }
        })(),
        timeoutPromise,
      ]);

      const verdict = parseVerdict(responseText);
      if (verdict) {
        debugLog(`[evolution] Tier 2 analysis complete: ${verdict.verdict} — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}`);
      }
      onComplete(verdict);
    } catch (err) {
      debugLog(`[evolution] Tier 2 analysis failed: ${err}`);
      onComplete(null);
    }
  })();
}
