import { describe, test, expect, vi } from 'bun:test';
import { SubAgentTool } from '../../src/agent/sub-agent-tool';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { Provider, AgentConfig, ToolImplementation } from '../../src/types';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';

const mockConfig: AgentConfig = { tokenLimit: 50000 };

describe('Sub-agent cwd isolation', () => {
  test('bash tool cwd is forced to isolated directory for code_editor profile', async () => {
    const mainRegistry = new ToolRegistry();

    let receivedCwd: string | undefined;
    const fakeBashImpl: ToolImplementation = {
      getDefinition: () => ({
        name: 'bash',
        description: 'run bash',
        parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
      }),
      execute: async (params: Record<string, unknown>) => {
        receivedCwd = params.cwd as string | undefined;
        return 'ok';
      },
    };

    mainRegistry.register(fakeBashImpl);
    mainRegistry.register({
      getDefinition: () => ({
        name: 'read',
        description: 'read file',
        parameters: { type: 'object', properties: {}, required: [] },
      }),
      execute: async () => 'file content',
    });

    const provider = {
      invoke: async () => ({ content: 'done' }),
      getModelName: () => 'test',
      stream: async function*() {
        yield { type: 'text_delta', text: 'Task completed.' };
        yield { type: 'done', done: true };
      },
    } as unknown as Provider;

    const tool = new SubAgentTool({
      mainProvider: provider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
      isolation: true,
      worktreeRootDir: '/tmp/test-worktrees',
    });

    // Spy on ToolRegistry.register to capture wrapped bash tool
    const registerSpy = vi.spyOn(ToolRegistry.prototype, 'register');

    try {
      await tool.execute(
        { goal: 'run a command', deliverable: 'summary', profile: 'code_editor' },
        createTestCtx({ cwd: '/original/cwd' }),
      );
    } catch {
      // Expected — the sub-agent loop may fail without full tool registry
    }

    // Extract the bash tool that was registered in the sub-agent registry
    const registeredBashCalls = registerSpy.mock.calls.filter(call => {
      const impl = call[0];
      return impl.getDefinition && impl.getDefinition().name === 'bash';
    });

    // There should be one bash registration (the wrapped one)
    expect(registeredBashCalls.length).toBeGreaterThanOrEqual(1);

    // Grab the wrapped bash implementation and execute it
    const wrappedBashImpl = registeredBashCalls[0][0] as ToolImplementation;
    await wrappedBashImpl.execute({ command: 'ls' }, createTestCtx({ cwd: '/original/cwd' }));

    // The execute should have forced cwd to the isolated directory
    expect(receivedCwd).toBeDefined();
    expect(receivedCwd!).toContain('test-worktrees');
    expect(receivedCwd).not.toBe('/original/cwd');

    registerSpy.mockRestore();
  });

  test('bash tool is excluded from read_only profile sub-agent registry', () => {
    const mainRegistry = new ToolRegistry();
    mainRegistry.register({
      getDefinition: () => ({
        name: 'bash',
        description: 'run bash',
        parameters: { type: 'object', properties: {}, required: [] },
      }),
      execute: async () => 'ok',
    });
    mainRegistry.register({
      getDefinition: () => ({
        name: 'read',
        description: 'read file',
        parameters: { type: 'object', properties: {}, required: [] },
      }),
      execute: async () => 'content',
    });

    const provider = {
      invoke: async () => ({ content: 'done' }),
      getModelName: () => 'test',
      stream: async function*() {
        yield { type: 'text_delta', text: 'Done.' };
        yield { type: 'done', done: true };
      },
    } as unknown as Provider;

    const tool = new SubAgentTool({
      mainProvider: provider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    const registerSpy = vi.spyOn(ToolRegistry.prototype, 'register');

    tool.execute(
      { goal: 'read something', deliverable: 'summary', profile: 'read_only' },
      createTestCtx(),
    ).catch(() => {});

    const registeredNames: string[] = [];
    registerSpy.mock.calls.forEach(call => {
      const impl = call[0];
      if (impl.getDefinition) {
        registeredNames.push(impl.getDefinition().name);
      }
    });

    expect(registeredNames).toContain('read');
    expect(registeredNames).not.toContain('bash');

    registerSpy.mockRestore();
  });
});
