import { describe, it, expect } from 'bun:test';
import { ContextManager } from '../../src/agent/context';

function makeMsg(role: 'user' | 'assistant', content: string) {
  return { role, content };
}

describe('ContextManager message cap', () => {
  it('should preserve system prompt and messages', () => {
    const cm = new ContextManager({ tokenLimit: 500000, defaultSystemPrompt: 'system prompt' });

    cm.addMessage(makeMsg('user', 'hello'));
    cm.addMessage(makeMsg('assistant', 'hi there'));

    const ctx = cm.getContext({ tokenLimit: 500000, provider: {} as any });
    expect(ctx.messages.length).toBe(3); // system + user + assistant
    expect(ctx.systemPrompt).toBe('system prompt');
  });

  it('should not trim when under limit', () => {
    const cm = new ContextManager({ tokenLimit: 100000 });
    for (let i = 0; i < 10; i++) {
      cm.addMessage(makeMsg('user', `message ${i}`));
    }
    expect(cm.getContext({ tokenLimit: 100000, provider: {} as any }).messages.length).toBe(10);
  });
});
