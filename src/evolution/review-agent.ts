import type { TraceRun, TraceStore } from '../trace/types';
import type { Provider } from '../types';
import { Agent } from '../agent/Agent';
import { ContextManager } from '../agent/context';
import { ToolRegistry } from '../agent/tool-registry';
import { CreateReviewSkillTool } from './review-tools';
import { buildReviewPrompt } from './prompt-templates';
import { debugLog } from '../utils/debug';
import fs from 'fs/promises';

const RECENT_SESSION_LIMIT = 10;
const RECENT_RUN_LIMIT = 3;

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
  reviewInterval?: number,
  recentTraceSummaries?: string[],
): string {
  const reviewPrompt = buildReviewPrompt(trigger, trace, existingSkills, reviewInterval, recentTraceSummaries);
  const skillsList = existingSkills.length > 0
    ? existingSkills.map((s) => `- ${s}`).join('\n')
    : '(none)';

  const skillCreationBlock = `

---
## Skill Creation

When you have identified a reusable pattern (score >= 3), create a skill by calling
the \`create_review_skill\` tool. The skill you write must be high-quality: it should
teach a future agent not just WHAT to do, but WHY.

### Anatomy of a Skill

A skill lives in its own directory:
\`\`\`
skill-name/
  SKILL.md          (required — YAML frontmatter + markdown instructions)
  scripts/          (optional — executable code for deterministic tasks)
  references/       (optional — docs loaded into context as needed)
  assets/           (optional — templates, icons, fonts used in output)
\`\`\`

For \`create_review_skill\`, focus on the \`SKILL.md\` body. If the workflow
needs a bundled script, describe it in the body — the tool writes a single
SKILL.md file.

### SKILL.md Format

Every SKILL.md has YAML frontmatter followed by markdown instructions:

\`\`\`markdown
---
name: my-skill-name
description: What this skill does and when to trigger it. Include both the
  core capability AND specific contexts where it should activate. Err on the
  side of being slightly pushy — skills tend to under-trigger, so mention
  near-miss phrasings that should also match.
---

# Skill Title

## When to use
...

## How to proceed
...
\`\`\`

The \`description\` field is the primary triggering mechanism. Claude decides
whether to invoke a skill based solely on this field, so make it count:
- Include BOTH what the skill does AND the contexts where it applies
- Use concrete trigger phrases: "use when the user asks to...", "trigger when..."
- Cover near-miss phrasings: if someone says "set up auth" instead of
  "configure authentication", both should match

### Writing Principles

These principles come from the skill-creator methodology and have been proven
to produce skills that work reliably across diverse situations:

**1. Explain WHY, not just WHAT.**
Today's LLMs are smart. They have good theory of mind and can adapt when they
understand reasoning. Instead of:
> ALWAYS run \`chmod +x\` before executing scripts.
Write:
> Scripts created during a session may not have the execute bit set. Running
> \`chmod +x\` prevents a "permission denied" error that would otherwise cost
> a turn to diagnose.

Explaining the reason behind each step lets the agent decide when to skip or
adapt it — which makes the skill useful in situations you did not anticipate.

**2. Use imperative form.**
Write "Check the Node version" not "You should check the Node version."
Imperative form is clearer and more direct.

**3. Include concrete examples.**
Abstract descriptions are hard to apply. Ground the skill with examples:

> **Example:**
> Input: a project with \`requirements.txt\` but no virtual environment
> Output: a \`.venv/\` directory with dependencies installed, and the agent
> knows to activate it before running Python commands

**4. Be specific about edge cases and workarounds.**
What goes wrong? What false paths did the agent take in the trace that led to
this skill? Warn future agents:
> If \`pip install\` fails with a "externally-managed-environment" error, do
> NOT try to force-install with \`--break-system-packages\`. Use a virtual
> environment or \`pipx\` instead.

**5. Include verification steps.**
Every workflow should end with a check: "run the tests", "verify the output
file exists and is non-empty", "confirm the API returns 200". Verification
catches mistakes before the user sees them.

**6. Keep it focused, not exhaustive.**
A skill should handle one class of problems well, not every variation loosely.
If you find yourself writing "if X then A, if Y then B, if Z then C..." for
10+ conditions, break it into multiple skills or reference files.

### Anti-patterns: When NOT to create a skill

Do NOT create a skill when:

- **The pattern is a one-off configuration detail** (e.g., "this project uses
  port 3001 instead of 3000"). That is project-specific memory, not a skill.
- **The workflow is purely mechanical** with no decision-making (e.g.,
  "run \`npm install\` then \`npm test\`"). Any agent can do this without a skill.
- **An existing skill already covers this**. Check the list below before
  creating. If an existing skill is close but missing something, mention in
  your response that the existing skill could be improved rather than creating
  a duplicate.
- **The skill would be a "how-to" document masquerading as a skill**. Skills are
  executable workflows, not reference manuals. "Guide to Python packaging" is
  too broad. "Set up a Python package with uv and pyproject.toml" is focused.

### Dedup reminder (read carefully)

Before calling \`create_review_skill\`, verify your proposed skill does not
overlap with any existing skill in this list:

${skillsList}

If there is overlap, either:
- Do NOT create the skill (explain why the existing one covers it), or
- Explain what the existing skill is missing and why a new skill is still needed

### Output directory

New skills will be written to: ${outputDir}

### Scoring summary

- Score < 3: respond with "Nothing to save" and a brief explanation of why the
  pattern is too narrow, trivial, or already covered
- Score >= 3: call \`create_review_skill\` with:
  - \`skill_name\`: kebab-case, descriptive, unique
  - \`description\`: one-line summary following the description writing principles above
  - \`body\`: markdown instructions following the skill writing principles above`;

  return reviewPrompt + skillCreationBlock;
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
    store?: TraceStore | undefined;
    reviewInterval?: number | undefined;
  },
): void {
  void (async () => {
    try {
      let recentTraceSummaries: string[] = [];
      if (config.store) {
        try {
          const recentRuns = await config.store.listRecent(RECENT_SESSION_LIMIT, RECENT_RUN_LIMIT);
          recentTraceSummaries = recentRuns.map(r =>
            `Run ${r.id}: ${r.summary.totalTurns} turns, ${r.summary.totalErrors} errors, outcome: ${r.summary.outcome}`,
          );
        } catch {
          /* best-effort */
        }
      }

      const existingSkills = await listExistingSkills(config.outputDir);
      const systemPrompt = buildReviewSystemPrompt(
        trigger, trace, existingSkills, config.outputDir,
        config.reviewInterval, recentTraceSummaries,
      );

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
