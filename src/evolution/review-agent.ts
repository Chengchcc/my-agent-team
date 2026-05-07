import type { TraceRun } from '../trace/types';
import type { Provider } from '../types';
import { Agent } from '../agent/Agent';
import { ContextManager } from '../agent/context';
import { ToolRegistry } from '../agent/tool-registry';
import { CreateReviewSkillTool } from './review-tools';
import { buildReviewPrompt } from './prompt-templates';
import { debugLog } from '../utils/debug';
import fs from 'fs/promises';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a system prompt for a review agent session.
 * Calls buildReviewPrompt from prompt-templates and appends instructions
 * for saving any new skill to the specified output directory.
 */
export function buildReviewSystemPrompt(
  trigger: 'error_burst' | 'complex_task' | 'periodic',
  trace: TraceRun,
  existingSkills: string[],
  outputDir: string,
): string {
  const reviewPrompt = buildReviewPrompt(trigger, trace, existingSkills);

  return `${reviewPrompt}

---
## Skill Creation

When you have identified a reusable pattern (score >= 3):
- Call the create_review_skill tool with the skill details
- skill_name: kebab-case, descriptive, unique
- description: one-line summary including trigger contexts
- body: markdown instructions for the skill

The output directory for new skills is: ${outputDir}

If the pattern is not reusable (score < 3), just say "Nothing to save" and explain why.
Do NOT create a skill if one already covers this pattern.`;
}

async function listExistingSkills(outputDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Fork a review agent in a fire-and-forget manner.
 *
 * Creates a real Agent instance with a lightweight model, runs it against
 * the provided trace, and emits onSkillCreated when the agent successfully
 * creates a skill via the create_review_skill tool.
 */
export function forkReviewAgent(
  trigger: 'error_burst' | 'complex_task' | 'periodic',
  trace: TraceRun,
  config: {
    outputDir: string;
    provider: Provider;
    model: string;
    maxTurns: number;
    tokenLimit: number;
    timeoutMs: number;
    onSkillCreated?: ((skillName: string, description: string, outputDir: string) => void) | undefined;
    onComplete?: (() => void) | undefined;
  },
): void {
  void (async () => {
    try {
      const existingSkills = await listExistingSkills(config.outputDir);
      const systemPrompt = buildReviewSystemPrompt(trigger, trace, existingSkills, config.outputDir);

      const toolRegistry = new ToolRegistry();
      const skillTool = new CreateReviewSkillTool(config.outputDir);
      toolRegistry.register(skillTool);

      const agent = new Agent({
        provider: config.provider,
        contextManager: new ContextManager({
          tokenLimit: config.tokenLimit,
          defaultSystemPrompt: systemPrompt,
        }),
        toolRegistry,
        config: { tokenLimit: config.tokenLimit },
        hooks: {},
        toolMiddlewares: [],
      });

      const userMessage = trace.summary.totalErrors > 0
        ? `Analyze this trace with ${trace.summary.totalErrors} errors`
        : `Analyze this ${trace.summary.totalTurns}-turn task`;

      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Review timeout')), config.timeoutMs),
      );

      await Promise.race([
        (async () => {
          for await (const event of agent.runAgentLoop(
            { role: 'user', content: userMessage },
            { maxTurns: config.maxTurns, timeoutMs: config.timeoutMs },
          )) {
            if (event.type === 'tool_call_result' && event.toolCall.name === 'create_review_skill') {
              const result = event.result as { created?: boolean; skill_name?: string; description?: string } | undefined;
              if (result?.created && result.skill_name) {
                config.onSkillCreated?.(
                  result.skill_name,
                  (event.toolCall.arguments as Record<string, unknown> | undefined)?.description as string ?? '',
                  config.outputDir,
                );
              }
            }
          }
        })(),
        timeoutPromise,
      ]);

      debugLog('[evolution] Review completed');
    } catch (err) {
      debugLog(`[evolution] Review failed: ${err}`);
    } finally {
      config.onComplete?.();
    }
  })();
}
