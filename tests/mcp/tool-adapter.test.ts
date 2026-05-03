import { describe, it, expect, mock } from 'bun:test';
import { McpToolAdapter, formatToolName } from '../../src/mcp/tool-adapter';
import type { McpManager } from '../../src/mcp/manager';

function mockManager(executeResult: unknown): McpManager {
  return {
    executeTool: mock(() => Promise.resolve(executeResult)),
  } as unknown as McpManager;
}

describe('formatToolName', () => {
  it('generates correct MCP tool name', () => {
    expect(formatToolName('github', 'search_code')).toBe('mcp__github__search_code');
  });
});

describe('McpToolAdapter', () => {
  it('generates correct tool definition', () => {
    const adapter = new McpToolAdapter(
      mockManager(''),
      'test-server',
      { name: 'list_items', description: 'List all items', parameters: { type: 'object', properties: {} } },
    );
    const def = adapter.getDefinition();
    expect(def.name).toBe('mcp__test-server__list_items');
    expect(def.description).toBe('List all items');
  });

  it('falls back to generated description when none provided', () => {
    const adapter = new McpToolAdapter(
      mockManager(''),
      'srv',
      { name: 'do_thing', parameters: {} },
    );
    const def = adapter.getDefinition();
    expect(def.description).toContain('MCP tool');
    expect(def.description).toContain('srv');
  });

  it('marks list_* tools as readonly', () => {
    const adapter = new McpToolAdapter(mockManager(''), 'srv', { name: 'list_users', parameters: {} });
    expect(adapter.readonly).toBe(true);
  });

  it('marks read_* tools as readonly', () => {
    const adapter = new McpToolAdapter(mockManager(''), 'srv', { name: 'read_file', parameters: {} });
    expect(adapter.readonly).toBe(true);
  });

  it('does not mark write_* tools as readonly', () => {
    const adapter = new McpToolAdapter(mockManager(''), 'srv', { name: 'write_file', parameters: {} });
    expect(adapter.readonly).toBe(false);
  });

  it('unwraps text content from execute result', async () => {
    const manager = mockManager({
      content: [{ type: 'text', text: 'hello world' }],
    });
    const adapter = new McpToolAdapter(manager, 'srv', { name: 'test', parameters: {} });
    const result = await adapter.execute({}, {} as never);
    expect(result).toBe('hello world');
  });

  it('prepends error prefix on isError result (does not throw)', async () => {
    const manager = mockManager({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    });
    const adapter = new McpToolAdapter(manager, 'srv', { name: 'test', parameters: {} });
    const result = await adapter.execute({}, {} as never);
    expect(result).toContain('[MCP tool error]');
    expect(result).toContain('something went wrong');
  });

  it('returns empty string for empty content', async () => {
    const manager = mockManager({ content: [] });
    const adapter = new McpToolAdapter(manager, 'srv', { name: 'test', parameters: {} });
    const result = await adapter.execute({}, {} as never);
    expect(result).toBe('');
  });
});
