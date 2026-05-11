import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { AgentContext } from '../../src/types';
import type { MemoryEntry, MemoryStore, MemoryRetriever } from '../../src/memory/types';
import { MemoryMiddleware } from '../../src/memory/middleware';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return { id: 'test-id', type: 'general', text: 'test',
    weight: 1, source: 'explicit', created: new Date().toISOString(), ...overrides };
}

class MockMemoryStore implements Partial<MemoryStore> {
  entries: MemoryEntry[] = [];
  getAll = vi.fn().mockImplementation(() => Promise.resolve([...this.entries]));
  markHit = vi.fn();
}

class MockRetriever implements Partial<MemoryRetriever> {
  results: MemoryEntry[] = [];
  search = vi.fn().mockResolvedValue([]);
}

function buildContext(overrides: Partial<AgentContext>): AgentContext {
  return { messages: [], systemPrompt: 'You are a helpful assistant.',
    config: { tokenLimit: 100000, defaultSystemPrompt: undefined, model: 'test' },
    metadata: {}, ...overrides };
}

describe('MemoryMiddleware.beforeModel', () => {
  let middleware: MemoryMiddleware;
  let mockRetriever: MockRetriever;
  let store: MockMemoryStore;

  beforeEach(() => {
    store = new MockMemoryStore();
    mockRetriever = new MockRetriever();
    middleware = new MemoryMiddleware(
      { general: store as any },
      mockRetriever as any,
    );
  });

  it('injects high-weight entries as <user_preferences>', async () => {
    store.entries = [makeEntry({ type: 'general', text: 'prefers vitest', weight: 0.95 })];
    const context = buildContext({
      messages: [{ role: 'user', content: 'set up tests' }],
      systemPrompt: 'Base prompt.',
    });

    await middleware.beforeModel!(context, async () => context);

    expect(context.systemPrompt).toContain('<user_preferences');
    expect(context.systemPrompt).toContain('prefers vitest');
  });

  it('does not inject low-weight entries into preferences', async () => {
    store.entries = [makeEntry({ type: 'general', text: 'trivial fact', weight: 0.5 })];
    const context = buildContext({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'original',
    });

    await middleware.beforeModel!(context, async () => context);
    expect(context.systemPrompt).not.toContain('trivial fact');
    expect(context.systemPrompt).not.toContain('<user_preferences>');
  });

  it('injects retrieved memory via ephemeral reminders', async () => {
    mockRetriever.search.mockResolvedValue([
      makeEntry({ text: 'fixed rendering bug', created: '2024-06-15T10:00:00Z' }),
    ]);
    const context = buildContext({
      messages: [{ role: 'user', content: 'rendering bug' }],
    });

    await middleware.beforeModel!(context, async () => context);
    expect(context.ephemeralReminders).toBeDefined();
    expect(context.ephemeralReminders![0]).toContain('<retrieved_memory>');
  });

  it('does not inject retrieved memory when store returns empty', async () => {
    mockRetriever.search.mockResolvedValue([]);
    store.entries = [];
    const context = buildContext({
      messages: [{ role: 'user', content: 'hello' }],
    });

    await middleware.beforeModel!(context, async () => context);
    expect(context.ephemeralReminders).toBeUndefined();
  });

  it('respects maxUserPreferences limit', async () => {
    store.entries = Array(30).fill(null).map((_, i) =>
      makeEntry({ text: `pref ${i}`, weight: 0.95 }));
    const context = buildContext({
      messages: [{ role: 'user', content: 'test' }],
    });
    await middleware.beforeModel!(context, async () => context);
    const count = (context.systemPrompt!.match(/- pref/g) || []).length;
    expect(count).toBeLessThanOrEqual(20);
  });
});
