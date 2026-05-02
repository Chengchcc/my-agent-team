import type { AgentContext, AgentMiddleware } from '../types';
import type { McpManager } from './manager';

const MAX_RESOURCES_INJECTED = 50;

export function createMcpResourceMiddleware(manager: McpManager): AgentMiddleware {
  let lastResourceKeys: string | null = null;

  return {
    beforeModel: async (ctx: AgentContext, next: () => Promise<AgentContext>) => {
      const resources = manager.getAllResources();
      if (resources.length === 0) return next();

      const currentKeys = resources
        .map(r => r.resource.uri)
        .sort()
        .join(',');
      if (currentKeys === lastResourceKeys) return next();
      lastResourceKeys = currentKeys;

      const injected = resources.slice(0, MAX_RESOURCES_INJECTED);
      let catalog = injected.map(r =>
        `- ${r.serverName}: ${r.resource.uri}${r.resource.mimeType ? ` (${r.resource.mimeType})` : ''}${r.resource.description ? ` — ${r.resource.description}` : ''}`,
      ).join('\n');

      if (resources.length > MAX_RESOURCES_INJECTED) {
        catalog += `\n... and ${resources.length - MAX_RESOURCES_INJECTED} more resources`;
      }

      ctx.ephemeralReminders ??= [];
      ctx.ephemeralReminders.push(`[MCP Resources Available]\n${catalog}`);
      return next();
    },
  };
}
