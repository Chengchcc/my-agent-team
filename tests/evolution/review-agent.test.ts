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

    expect(prompt).toContain('output directory');
    expect(prompt).toContain('create_review_skill');
    expect(prompt).toContain(TEST_DIR);
  });
});
