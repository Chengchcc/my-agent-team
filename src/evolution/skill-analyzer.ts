import type { SkillStats } from './types';

export interface TraceSnippet {
  outcome: string;
  traces: string;
}

export interface AnalysisVerdict {
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
