import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { forkReviewAgent, buildReviewSystemPrompt } from '../../src/evolution/review-agent';
import type { TraceRun } from '../../src/trace/types';
import type { Provider, AgentContext, Tool, LLMResponse, LLMResponseChunk } from '../../src/types';

const TEST_DIR = path.join(os.tmpdir(), `evolution-agent-${Date.now()}`);

function makeMockProvider(): Provider {
  return {
    registerTools(_tools: Tool[]): void { /* noop */ },
    async invoke(_context: AgentContext): Promise<LLMResponse> {
      return { text: '', usage: { prompt_tokens: 0, completion_tokens: 0 } };
    },
    stream(_context: AgentContext): AsyncIterable<LLMResponseChunk> {
      return (async function* () { /* empty */ })();
    },
    getModelName(): string { return 'mock-model'; },
  };
}

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    startTime: Date.now(),
    endTime: Date.now(),
    model: 'test',
    turns: [{
      turnIndex: 0,
      modelResponse: {
        text: 'ok',
        toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      toolExecutions: [
        { toolName: 'bash', success: false, durationMs: 100, error: 'ENOENT' },
      ],
    }],
    summary: {
      totalTurns: 1, totalToolCalls: 1, totalErrors: 1,
      totalTokens: { prompt_tokens: 10, completion_tokens: 5 },
      outcome: 'error' as const,
    },
    ...overrides,
  };
}

describe('forkReviewAgent', () => {
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('does not throw when called (fire-and-forget)', () => {
    const trace = makeTrace();
    const provider = makeMockProvider();
    expect(() => {
      forkReviewAgent('error_burst', trace, {
        outputDir: TEST_DIR,
        provider,
        model: 'test-model',
        maxTurns: 3,
        tokenLimit: 10000,
        timeoutMs: 30000,
      });
    }).not.toThrow();
  });

  test('buildReviewSystemPrompt includes review prompt and output dir', () => {
    const trace = makeTrace();
    const prompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);

    expect(prompt).toContain('Output directory');
    expect(prompt).toContain('create_review_skill');
    expect(prompt).toContain(TEST_DIR);
  });

  // -----------------------------------------------------------------------
  // New tests: skill creation instructions content
  // -----------------------------------------------------------------------

  test('buildReviewSystemPrompt includes Anatomy of a Skill', () => {
    const trace = makeTrace();
    const prompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);

    expect(prompt).toContain('Anatomy of a Skill');
    expect(prompt).toContain('SKILL.md');
    expect(prompt).toContain('scripts/');
    expect(prompt).toContain('references/');
    expect(prompt).toContain('assets/');
  });

  test('buildReviewSystemPrompt includes SKILL.md format spec', () => {
    const trace = makeTrace();
    const prompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);

    expect(prompt).toContain('SKILL.md Format');
    expect(prompt).toContain('YAML frontmatter');
    expect(prompt).toContain('name: my-skill-name');
    expect(prompt).toContain('description:');
  });

  test('buildReviewSystemPrompt includes writing principles', () => {
    const trace = makeTrace();
    const prompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);

    expect(prompt).toContain('Writing Principles');
    expect(prompt).toContain('Explain WHY');
    expect(prompt).toContain('imperative form');
    expect(prompt).toContain('Include concrete examples');
    expect(prompt).toContain('edge cases');
    expect(prompt).toContain('verification steps');
    expect(prompt).toContain('Keep it focused');
  });

  test('buildReviewSystemPrompt includes anti-patterns for skill creation', () => {
    const trace = makeTrace();
    const prompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);

    expect(prompt).toContain('Anti-patterns');
    expect(prompt).toContain('one-off configuration detail');
    expect(prompt).toContain('purely mechanical');
    expect(prompt).toContain('how-to" document masquerading');
  });

  test('buildReviewSystemPrompt includes dedup reminder with existing skills', () => {
    const trace = makeTrace();
    const skills = ['existing-pattern', 'already-covered'];
    const prompt = buildReviewSystemPrompt('error_burst', trace, skills, TEST_DIR);

    expect(prompt).toContain('Dedup reminder');
    expect(prompt).toContain('existing-pattern');
    expect(prompt).toContain('already-covered');
  });

  test('buildReviewSystemPrompt includes description writing guidance', () => {
    const trace = makeTrace();
    const prompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);

    expect(prompt).toContain('triggering mechanism');
    expect(prompt).toContain('near-miss phrasings');
    expect(prompt).toContain('under-trigger');
  });

  test('buildReviewSystemPrompt with no existing skills shows (none) in dedup', () => {
    const trace = makeTrace();
    const prompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);

    expect(prompt).toContain('(none)');
  });

  test('buildReviewSystemPrompt includes scoring summary', () => {
    const trace = makeTrace();
    const prompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);

    expect(prompt).toContain('Scoring summary');
    expect(prompt).toContain('Nothing to save');
    expect(prompt).toContain('kebab-case');
  });

  // -----------------------------------------------------------------------
  // Verify cross-prompt integration
  // -----------------------------------------------------------------------

  test('complex_task trigger still wired to skill creation instructions', () => {
    const trace = makeTrace({
      summary: { totalTurns: 5, totalToolCalls: 5, totalErrors: 0,
        totalTokens: { prompt_tokens: 50, completion_tokens: 25 }, outcome: 'completed' as const },
    });
    const prompt = buildReviewSystemPrompt('complex_task', trace, [], TEST_DIR);

    expect(prompt).toContain('successful multi-step');
    expect(prompt).toContain('Anatomy of a Skill');
    expect(prompt).toContain(TEST_DIR);
  });
});
