import { SubAgentTool } from '../../src/agent/sub-agent-tool';
import { ContextManager } from '../../src/agent/context';
import { TraceBuffer } from '../../src/trace/trace-buffer';
import { TraceStore } from '../../src/trace/store';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { Provider, AgentConfig } from '../../src/types';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';
import { vi, test, expect } from 'bun:test';
import path from 'path';
import os from 'os';

const mockProvider: Provider = {
  registerTools: () => {},
  invoke: async () => { throw new Error('not implemented'); },
  stream: async function*() { yield { done: true }; },
  getModelName: () => 'test',
};
const mockConfig: AgentConfig = { tokenLimit: 50000 };

test('sub-agent ContextManager receives _parentTraceRunId from parent buffer', async () => {
  const store = new TraceStore(path.join(os.tmpdir(), `sub-trace-test-${Date.now()}`));
  const parentBuffer = new TraceBuffer('parent-session', store);
  const parentRunId = parentBuffer.runId;

  const tool = new SubAgentTool({
    mainProvider: mockProvider,
    mainToolRegistry: new ToolRegistry(),
    mainAgentConfig: mockConfig,
  });

  const contextSpy = vi.spyOn(ContextManager.prototype, 'getContext');

  const testCtx = createTestCtx();
  (testCtx.agentContext as Record<string, unknown>).metadata = {
    ...testCtx.agentContext.metadata,
    _traceBuffer: parentBuffer,
  };

  try {
    await tool.execute({ goal: 'test', deliverable: 'summary' }, testCtx);
  } catch {}

  expect(contextSpy).toHaveBeenCalled();
  const subCtx = contextSpy.mock.results[0]?.value;
  if (subCtx) {
    expect(subCtx.metadata._parentTraceRunId).toBe(parentRunId);
  }

  contextSpy.mockRestore();
});
