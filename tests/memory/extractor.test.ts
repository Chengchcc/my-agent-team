import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { Provider, AgentContext } from '../../src/types';
import type { TraceExtractionContext } from '../../src/memory/types';
import { LlmExtractor } from '../../src/memory/extractor';

class MockProvider implements Partial<Provider> {
  invokeResponse: string = '[]';
  invoke = vi.fn().mockImplementation(() => Promise.resolve({ content: this.invokeResponse }));
}

function makeTraceContext(overrides: Partial<TraceExtractionContext> = {}): TraceExtractionContext {
  return {
    userTurns: [{ content: 'Can you set up vitest? I prefer it over jest.' }],
    toolCalls: [{ tool: 'bash', success: true }],
    outcomes: ['Configured vitest in the Bun monorepo.'],
    totalTurns: 2, totalErrors: 0, ...overrides,
  };
}

describe('LlmExtractor.extract', () => {
  let extractor: LlmExtractor;
  let mockProvider: MockProvider;

  beforeEach(() => {
    mockProvider = new MockProvider();
    extractor = new LlmExtractor(mockProvider as any);
  });

  it('extracts memory entries from trace context', async () => {
    mockProvider.invokeResponse = `[
      {"text": "User prefers vitest over jest", "tags": ["testing"], "weight": 0.9},
      {"text": "TypeScript monorepo using Bun", "weight": 0.8}
    ]`;
    const entries = await extractor.extract(makeTraceContext());
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('general');
    expect(entries[0].source).toBe('implicit');
  });

  it('empty array from LLM → empty result', async () => {
    mockProvider.invokeResponse = '[]';
    const entries = await extractor.extract(makeTraceContext());
    expect(entries).toHaveLength(0);
  });

  it('non-JSON response → empty result', async () => {
    mockProvider.invokeResponse = 'no memories here';
    const entries = await extractor.extract(makeTraceContext());
    expect(entries).toHaveLength(0);
  });

  it('extracts JSON wrapped in extra text', async () => {
    mockProvider.invokeResponse = `Here: [{"text": "prefers tabs", "weight": 0.7}]`;
    const entries = await extractor.extract(makeTraceContext());
    expect(entries).toHaveLength(1);
  });

  it('filters out entries with empty text', async () => {
    mockProvider.invokeResponse = `[
      {"text": "", "weight": 0.5},
      {"text": "valid", "weight": 0.8}
    ]`;
    const entries = await extractor.extract(makeTraceContext());
    expect(entries).toHaveLength(1);
  });

  it('prompt includes trace context details', async () => {
    const promptSpy = vi.spyOn(extractor as any, 'buildExtractionPrompt');
    mockProvider.invokeResponse = '[]';
    await extractor.extract(makeTraceContext({
      userTurns: [{ content: 'fix pnpm install bug' }],
      outcomes: ['Fixed pnpm install hang on Node 22'],
    }));
    const prompt = promptSpy.mock.results[0].value as string;
    expect(prompt).toContain('pnpm install');
    expect(prompt).toContain('Node 22');
  });
});
