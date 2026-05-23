import { describe, it, expect } from 'bun:test';
import { createMcpListServersTool } from '../../src/extensions/mcp/tools';
import type { McpManager } from '../../src/extensions/mcp/manager';
import type { ToolContext } from '../../src/application/ports/tool-context';

const dummyCtx: ToolContext = { signal: new AbortController().signal, environment: { cwd: '/' } };

function mockManagerWithStates(states: Map<string, unknown>): McpManager {
  return {
    getConnectionStates: () => states,
  } as unknown as McpManager;
}

describe('createMcpListServersTool', () => {
  it('returns message when no servers', async () => {
    const manager = mockManagerWithStates(new Map());
    const tool = createMcpListServersTool(manager);
    const result = await tool.execute(dummyCtx, {});
    expect(result).toBe('No MCP servers configured.');
  });

  it('lists connected server with tool count', async () => {
    const states = new Map();
    states.set('test', {
      status: 'connected',
      capabilities: { tools: [{ name: 't1', parameters: {} }], resources: [], prompts: [] },
      startedAt: Date.now(),
    });
    const manager = mockManagerWithStates(states);
    const tool = createMcpListServersTool(manager);
    const result = await tool.execute(dummyCtx, {});
    expect(result).toContain('test');
    expect(result).toContain('connected');
    expect(result).toContain('1 tools');
  });

  it('shows error status with message', async () => {
    const states = new Map();
    states.set('bad', {
      status: 'error',
      message: 'Connection refused',
      since: Date.now(),
    });
    const manager = mockManagerWithStates(states);
    const tool = createMcpListServersTool(manager);
    const result = await tool.execute(dummyCtx, {});
    expect(result).toContain('bad');
    expect(result).toContain('error');
    expect(result).toContain('Connection refused');
  });
});
