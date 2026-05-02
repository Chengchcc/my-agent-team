import { describe, it, expect } from 'bun:test';
import { createMcpResourceMiddleware } from '../../src/mcp/resource-middleware';
import type { McpManager } from '../../src/mcp/manager';
import type { AgentContext } from '../../src/types';

function mockManager(resources: Array<{ serverName: string; resource: { uri: string; name: string; description?: string; mimeType?: string } }>): McpManager {
  return {
    getAllResources: () => resources,
  } as unknown as McpManager;
}

describe('createMcpResourceMiddleware', () => {
  it('injects resource catalog into ephemeralReminders', async () => {
    const manager = mockManager([
      { serverName: 'test', resource: { uri: 'file:///data', name: 'data', description: 'Test data', mimeType: 'text/plain' } },
    ]);
    const middleware = createMcpResourceMiddleware(manager);
    const ctx: AgentContext = {
      messages: [],
      config: { tokenLimit: 100000 },
      metadata: {},
    };

    const next = async () => ctx;
    if (middleware.beforeModel) {
      await middleware.beforeModel(ctx, next);
    }

    expect(ctx.ephemeralReminders).toBeDefined();
    expect(ctx.ephemeralReminders![0]).toContain('file:///data');
    expect(ctx.ephemeralReminders![0]).toContain('Test data');
  });

  it('skips when no resources', async () => {
    const manager = mockManager([]);
    const middleware = createMcpResourceMiddleware(manager);
    const ctx: AgentContext = { messages: [], config: { tokenLimit: 100000 }, metadata: {} };
    const next = async () => ctx;
    if (middleware.beforeModel) {
      await middleware.beforeModel(ctx, next);
    }
    expect(ctx.ephemeralReminders).toBeUndefined();
  });

  it('skips on same resource set to avoid duplicate injection', async () => {
    const manager = mockManager([
      { serverName: 'a', resource: { uri: 'u1', name: 'n1' } },
    ]);
    const middleware = createMcpResourceMiddleware(manager);
    const ctx: AgentContext = { messages: [], config: { tokenLimit: 100000 }, metadata: {} };
    const next = async () => ctx;
    if (middleware.beforeModel) {
      await middleware.beforeModel(ctx, next);
    }
    expect(ctx.ephemeralReminders).toHaveLength(1);

    // Second call with same resources should not add another reminder
    if (middleware.beforeModel) {
      await middleware.beforeModel(ctx, next);
    }
    expect(ctx.ephemeralReminders).toHaveLength(1);
  });
});
