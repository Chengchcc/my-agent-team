import { describe, it, expect, vi } from 'bun:test';
import { AgentLoop } from '../../src/agent/agent-loop';
import { ContextManager } from '../../src/agent/context';
import type { Provider, AgentConfig, AgentHooks, LLMResponseChunk } from '../../src/types';

function makeConfig(): AgentConfig {
  return { tokenLimit: 100000 };
}

function makeHooks(): Required<AgentHooks> {
  return {
    beforeAgentRun: [],
    beforeCompress: [],
    beforeModel: [],
    afterModel: [],
    beforeAddResponse: [],
    afterAgentRun: [],
  };
}

describe('Stream interruption recovery', () => {
  it('should save partial content when stream breaks mid-response', { timeout: 15000 }, async () => {
    const contextManager = new ContextManager({ tokenLimit: 100000 });
    let streamCallCount = 0;

    const flakyProvider: Provider = {
      invoke: async () => { throw new Error('not used'); },
      getModelName: () => 'test',
      stream: async function*() {
        streamCallCount++;
        yield { content: 'Here is the analysis', done: false } as LLMResponseChunk;
        yield { content: ' of the file:', done: false } as LLMResponseChunk;
        throw new Error('fetch failed: ECONNRESET');
      },
    };

    const mockDispatcher = {
      dispatch: async function*() {},
      dispatchSequential: async function*() {},
      dispatchParallelBatch: async function*() {},
      dispatchParallelStreaming: async function*() {},
    } as any;

    const loop = new AgentLoop(flakyProvider, contextManager, makeHooks(), makeConfig(), mockDispatcher);

    const events: any[] = [];
    try {
      for await (const event of loop.run(
        { role: 'user', content: 'Analyze this file' },
        { maxTurns: 1, timeoutMs: 30000 },
      )) {
        events.push(event);
      }
    } catch {
      // May throw if no partial content
    }

    // text_delta events emitted for partial content
    const textEvents = events.filter((e: any) => e.type === 'text_delta');
    expect(textEvents.length).toBeGreaterThanOrEqual(2);

    // Context should contain partial assistant message
    const ctx = contextManager.getContext(makeConfig());
    const assistantMsgs = ctx.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
  });

  it('should retry on network errors up to 3 times', async () => {
    const contextManager = new ContextManager({ tokenLimit: 100000 });
    let streamCallCount = 0;

    const recoveringProvider: Provider = {
      invoke: async () => { throw new Error('not used'); },
      getModelName: () => 'test',
      stream: async function*() {
        streamCallCount++;
        if (streamCallCount <= 2) {
          throw new Error('fetch failed: ETIMEDOUT');
        }
        yield { content: 'Success on attempt ' + streamCallCount, done: true } as LLMResponseChunk;
      },
    };

    const mockDispatcher = {
      dispatch: async function*() {},
      dispatchSequential: async function*() {},
      dispatchParallelBatch: async function*() {},
      dispatchParallelStreaming: async function*() {},
    } as any;

    const loop = new AgentLoop(recoveringProvider, contextManager, makeHooks(), makeConfig(), mockDispatcher);

    const events: any[] = [];
    for await (const event of loop.run(
      { role: 'user', content: 'Hello' },
      { maxTurns: 1, timeoutMs: 30000 },
    )) {
      events.push(event);
    }

    // Retried and succeeded on 3rd attempt
    expect(streamCallCount).toBe(3);
    const doneEvents = events.filter((e: any) => e.type === 'agent_done');
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].reason).not.toBe('error');
  });

  it('should throw immediately on fatal errors without retry', async () => {
    const contextManager = new ContextManager({ tokenLimit: 100000 });
    let streamCallCount = 0;

    const fatalProvider: Provider = {
      invoke: async () => { throw new Error('not used'); },
      getModelName: () => 'test',
      stream: async function*() {
        streamCallCount++;
        throw new Error('Invalid API key: authentication failed');
      },
    };

    const mockDispatcher = {
      dispatch: async function*() {},
      dispatchSequential: async function*() {},
      dispatchParallelBatch: async function*() {},
      dispatchParallelStreaming: async function*() {},
    } as any;

    const loop = new AgentLoop(fatalProvider, contextManager, makeHooks(), makeConfig(), mockDispatcher);

    const events: any[] = [];
    for await (const event of loop.run(
      { role: 'user', content: 'Hello' },
      { maxTurns: 1, timeoutMs: 30000 },
    )) {
      events.push(event);
    }

    // No retry — only 1 call
    expect(streamCallCount).toBe(1);
    const errorEvents = events.filter((e: any) => e.type === 'agent_error');
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
  });
});
