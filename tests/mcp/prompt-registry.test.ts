import { describe, it, expect, mock } from 'bun:test';
import { McpPromptRegistry, formatPromptName } from '../../src/mcp/prompt-registry';
import type { McpManager } from '../../src/mcp/manager';
import { ToolRegistry } from '../../src/agent/tool-registry';

function mockManager(): McpManager {
  return {
    getAllPrompts: () => [
      {
        serverName: 'test',
        prompt: {
          name: 'greeting',
          description: 'Generate a greeting',
          arguments: [{ name: 'name', description: 'User name', required: true }],
        },
      },
    ],
    getPrompt: mock(async () => ({
      messages: [{ role: 'user' as const, content: 'Hello there' }],
    })),
  } as unknown as McpManager;
}

describe('formatPromptName', () => {
  it('generates correct prompt tool name', () => {
    expect(formatPromptName('github', 'greeting')).toBe('mcp__github__prompt__greeting');
  });
});

describe('McpPromptRegistry', () => {
  it('registers prompt as tool in ToolRegistry', () => {
    const manager = mockManager();
    const registry = new McpPromptRegistry(manager);
    const toolRegistry = new ToolRegistry();

    const all = registry.getAll();
    expect(all.length).toBe(1);
    registry.registerAsTool(all[0]!.serverName, all[0]!.prompt, toolRegistry);

    const tool = toolRegistry.get('mcp__test__prompt__greeting');
    expect(tool).toBeDefined();
    const def = tool!.getDefinition();
    expect(def.parameters.required).toEqual(['name']);
  });

  it('executes prompt via manager.getPrompt', async () => {
    const manager = mockManager();
    const registry = new McpPromptRegistry(manager);
    const toolRegistry = new ToolRegistry();

    registry.registerAsTool('test', {
      name: 'greeting',
      arguments: [{ name: 'name', required: true }],
    }, toolRegistry);

    const tool = toolRegistry.get('mcp__test__prompt__greeting');
    const result = await tool!.execute({ name: 'Alice' }, {} as never);
    expect(result).toContain('Hello there');
    expect(result).toContain('[user]');
  });
});
