import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CreateReviewSkillTool } from '../../src/evolution/review-tools';
import { buildReviewPrompt } from '../../src/evolution/prompt-templates';
import { buildReviewSystemPrompt } from '../../src/evolution/review-agent';
import type { TraceRun } from '../../src/trace/types';
import { ContextManager } from '../../src/agent/context';
import type { ToolContext } from '../../src/agent/tool-dispatch/types';

const TEST_DIR = path.join(os.tmpdir(), `evolution-e2e-${Date.now()}`);

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-e2e',
    sessionId: 'session-e2e',
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    model: 'test',
    turns: [
      {
        turnIndex: 0,
        userMessage: 'fix the bug',
        modelResponse: { text: 'let me check', toolCalls: [{ name: 'grep', arguments: { pattern: 'error' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        toolExecutions: [{ toolName: 'grep', success: true, durationMs: 50 }],
      },
      {
        turnIndex: 1,
        modelResponse: { text: 'found it', toolCalls: [{ name: 'text_editor', arguments: { path: 'src/index.ts' } }], usage: { prompt_tokens: 15, completion_tokens: 5 } },
        toolExecutions: [{ toolName: 'text_editor', success: false, durationMs: 200, error: 'EACCES: permission denied' }],
      },
    ],
    summary: { totalTurns: 2, totalToolCalls: 2, totalErrors: 1, totalTokens: { prompt_tokens: 25, completion_tokens: 10 }, outcome: 'error' as const },
    ...overrides,
  };
}

function createTestCtx(): ToolContext {
  const cm = new ContextManager({ tokenLimit: 10000 });
  return {
    agentContext: cm.getContext({ tokenLimit: 10000 }),
    environment: { cwd: process.cwd() },
  } as unknown as ToolContext;
}

describe('Evolution integration', () => {
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('full flow: prompt -> tool call -> skill written', async () => {
    const trace = makeTrace();

    const prompt = buildReviewPrompt('error_burst', trace, []);
    expect(prompt).toContain('EACCES');
    expect(prompt).toContain('Score reusability');

    const systemPrompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);
    expect(systemPrompt).toContain('create_review_skill');
    expect(systemPrompt).toContain(TEST_DIR);

    const tool = new CreateReviewSkillTool(TEST_DIR);
    const result = await tool.execute({
      skill_name: 'fix-permission-errors',
      description: 'Handle permission errors when editing files \u2014 use bash to chmod first',
      body: '## When you see EACCES\n\n1. Check file ownership\n2. Use chmod',
      pitfalls: 'Always verify you have write access before editing',
    }, createTestCtx());

    // execute() returns { created: true, skill_name, path }
    expect(result).toMatchObject({ created: true, skill_name: 'fix-permission-errors' });

    const skillMd = await fs.readFile(
      path.join(TEST_DIR, 'fix-permission-errors', 'SKILL.md'), 'utf-8',
    );
    expect(skillMd).toContain('name: fix-permission-errors');
    expect(skillMd).toContain('EACCES');
    expect(skillMd).toContain('## Pitfalls');
  });

  test('dedup prevents duplicate skill creation', async () => {
    const tool = new CreateReviewSkillTool(TEST_DIR);
    const ctx = createTestCtx();

    await tool.execute({ skill_name: 'unique-skill', description: 'A', body: 'B' }, ctx);
    const result = await tool.execute({ skill_name: 'unique-skill', description: 'A', body: 'C' }, ctx);
    // Second call returns { created: false, reason: 'Skill already exists', skill_name: 'unique-skill' }
    expect(result).toMatchObject({ created: false, skill_name: 'unique-skill' });
    expect((result as { reason: string }).reason).toContain('already exists');
  });

  test('complex_task prompt contains workflow extraction instructions', () => {
    const trace = makeTrace({
      summary: { totalTurns: 5, totalToolCalls: 5, totalErrors: 0, totalTokens: { prompt_tokens: 100, completion_tokens: 50 }, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('complex_task', trace, []);
    expect(prompt).toContain('successful multi-step');
    expect(prompt).toContain('Score reusability');
  });
});
