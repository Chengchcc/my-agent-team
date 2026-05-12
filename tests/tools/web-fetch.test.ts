import { describe, test, expect } from 'bun:test';
import { WebFetchTool } from '../../src/tools/web-fetch';
import type { ToolContext } from '../../src/agent/tool-dispatch/types';

function createTestCtx(signal?: AbortSignal): ToolContext {
  return {
    signal: signal ?? new AbortController().signal,
    agentContext: {} as never,
    budget: { remaining: 100_000, usageRatio: 0 },
    environment: { agentType: 'main', cwd: '/' },
    metadata: new Map(),
    sink: { updateTodos: () => {}, _todoUpdates: undefined },
  };
}

// Mock functions that tests can inject
const mockTavily = async (_url: string, _mode: 'markdown' | 'text', _apiKey: string) => ({
  title: 'Tavily Title',
  content: 'Tavily extracted content',
});

const mockHeadless = async (_url: string) => ({
  title: 'Headless Title',
  content: 'Headless browser content',
});

const failingTavily = async () => {
  throw new Error('Tavily API error');
};

describe('WebFetchTool', () => {
  describe('getDefinition', () => {
    test('name is web_fetch', () => {
      const tool = new WebFetchTool();
      expect(tool.getDefinition().name).toBe('web_fetch');
    });

    test('readonly is true', () => {
      const tool = new WebFetchTool();
      expect(tool.readonly).toBe(true);
    });

    test('schema: url is string and required', () => {
      const tool = new WebFetchTool();
      const def = tool.getDefinition();
      const props = def.parameters.properties as Record<string, unknown>;
      const required = def.parameters.required as string[];

      const urlSchema = props.url as Record<string, unknown>;
      expect(urlSchema.type).toBe('string');
      expect(required).toContain('url');
    });

    test('schema: mode has default markdown and is not required', () => {
      const tool = new WebFetchTool();
      const def = tool.getDefinition();
      const props = def.parameters.properties as Record<string, unknown>;
      const required = def.parameters.required as string[] | undefined;

      const modeSchema = props.mode as Record<string, unknown>;
      expect(modeSchema.type).toBe('string');
      expect(modeSchema.enum).toEqual(['markdown', 'text']);
      expect(modeSchema.default).toBe('markdown');
      if (required) {
        expect(required).not.toContain('mode');
      }
    });

    test('schema: maxChars defaults to 50000 and is not required', () => {
      const tool = new WebFetchTool();
      const def = tool.getDefinition();
      const props = def.parameters.properties as Record<string, unknown>;
      const required = def.parameters.required as string[] | undefined;

      const maxCharsSchema = props.maxChars as Record<string, unknown>;
      expect(maxCharsSchema.type).toBe('number');
      expect(maxCharsSchema.default).toBe(50_000);
      if (required) {
        expect(required).not.toContain('maxChars');
      }
    });
  });

  describe('execute validation', () => {
    test('rejects invalid URL', async () => {
      const tool = new WebFetchTool(mockHeadless, mockTavily);
      await expect(
        tool.execute({ url: 'not-a-url' }, createTestCtx()),
      ).rejects.toThrow('Parameter validation failed');
    });

    test('rejects empty params', async () => {
      const tool = new WebFetchTool(mockHeadless, mockTavily);
      await expect(
        tool.execute({}, createTestCtx()),
      ).rejects.toThrow('Parameter validation failed');
    });

    test('rejects maxChars below minimum', async () => {
      const tool = new WebFetchTool(mockHeadless, mockTavily);
      await expect(
        tool.execute({ url: 'https://example.com', maxChars: 500 }, createTestCtx()),
      ).rejects.toThrow('Parameter validation failed');
    });
  });

  describe('handle with mocks', () => {
    test('uses Tavily when API key is available (via mock)', async () => {
      const tool = new WebFetchTool(mockHeadless, mockTavily);

      const result = await tool.execute(
        { url: 'https://example.com' },
        createTestCtx(),
      );

      expect(result).toHaveProperty('url', 'https://example.com');
      // The real settings has Tavily key → uses Tavily mock
      expect(result).toHaveProperty('format', 'markdown');
      expect(result).toHaveProperty('truncated', false);
    });

    test('falls back to headless when Tavily fails', async () => {
      const tool = new WebFetchTool(mockHeadless, failingTavily);

      const result = await tool.execute(
        { url: 'https://example.com' },
        createTestCtx(),
      );

      expect(result).toHaveProperty('url', 'https://example.com');
      expect(result).toHaveProperty('extractedVia', 'headless');
      expect(result).toHaveProperty('title', 'Headless Title');
      expect(result).toHaveProperty('content', 'Headless browser content');
    });

    test('truncates content exceeding maxChars', async () => {
      const longHeadless = async (_url: string) => ({
        title: 'Long Page',
        content: 'x'.repeat(2000),
      });
      // Use failing Tavily to force headless path, then inject our long-content mock
      const tool = new WebFetchTool(longHeadless, failingTavily);

      const result = await tool.execute(
        { url: 'https://example.com', maxChars: 1000 },
        createTestCtx(),
      ) as Record<string, unknown>;

      expect(result).toHaveProperty('extractedVia', 'headless');
      expect(result).toHaveProperty('truncated', true);
    });

    test('text mode returns format text', async () => {
      const textTavily = async () => ({
        title: 'Page',
        content: 'Plain text',
      });
      const tool = new WebFetchTool(mockHeadless, textTavily);

      const result = await tool.execute(
        { url: 'https://example.com', mode: 'text' },
        createTestCtx(),
      );

      expect(result).toHaveProperty('format', 'text');
    });

    test('aborted signal rejects', async () => {
      const controller = new AbortController();
      controller.abort();
      const slowMock = () => new Promise(() => {}); // never resolves
      const tool = new WebFetchTool(mockHeadless, slowMock);

      await expect(
        tool.execute({ url: 'https://example.com' }, createTestCtx(controller.signal)),
      ).rejects.toThrow('Fetch aborted');
    });
  });
});
