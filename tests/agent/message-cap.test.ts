import { describe, it, expect } from 'bun:test';
import { ContextManager } from '../../src/agent/context';

function makeMsg(role: 'user' | 'assistant', content: string) {
  return { role, content };
}

describe('ContextManager message cap', () => {
  it('should trim old messages when exceeding 2000', () => {
    const cm = new ContextManager({ tokenLimit: 500000 });
    cm.setSystemPrompt('system prompt');

    for (let i = 0; i < 2005; i++) {
      cm.addMessage(makeMsg('user', `message ${i}`));
    }

    const ctx = cm.getContext({ tokenLimit: 500000, provider: {} as any });
    expect(ctx.messages.length).toBeLessThanOrEqual(2001);
    const systemMsgs = ctx.messages.filter(m => m.role === 'system');
    expect(systemMsgs.length).toBe(1);
  });

  it('should not trim when under limit', () => {
    const cm = new ContextManager({ tokenLimit: 100000 });
    for (let i = 0; i < 10; i++) {
      cm.addMessage(makeMsg('user', `message ${i}`));
    }
    expect(cm.getContext({ tokenLimit: 100000, provider: {} as any }).messages.length).toBe(10);
  });
});
