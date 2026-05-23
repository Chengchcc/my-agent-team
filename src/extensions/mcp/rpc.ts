import type { McpServerConfig } from '../../config/types';
import type { McpManager } from './manager';

export function createMcpRpc(manager: McpManager, bus: { emit: (event: string, payload: unknown) => Promise<void> }) {
  return {
    'mcp.list': () => {
      const servers: Array<{
        name: string; status: string; capabilities: { tools: number; resources: number; prompts: number }; message?: string;
      }> = [];
      for (const [name, state] of manager.getConnectionStates()) {
        if (state.status === 'connected') {
          servers.push({
            name, status: state.status,
            capabilities: { tools: state.capabilities.tools.length, resources: state.capabilities.resources.length, prompts: state.capabilities.prompts.length },
          });
        } else if (state.status === 'error' || state.status === 'exhausted') {
          servers.push({ name, status: state.status, capabilities: { tools: 0, resources: 0, prompts: 0 }, message: state.message });
        } else {
          servers.push({ name, status: state.status, capabilities: { tools: 0, resources: 0, prompts: 0 } });
        }
      }
      return { servers };
    },
    'mcp.add': async (params: unknown) => {
      const p = params as { config?: McpServerConfig } | undefined;
      const config = p?.config;
      if (!config?.name || !config?.transport) {
        throw new Error('config must include name and transport');
      }
      await manager.connectServer(config);
      await bus.emit('mcp.reloaded', { reconnected: [config.name], failed: [] });
      return { ok: true, name: config.name };
    },
    'mcp.remove': async (params: unknown) => {
      const p = params as { name?: string } | undefined;
      const name = p?.name;
      if (!name) throw new Error('name is required');
      await manager.removeServer(name);
      return { ok: true };
    },
    'mcp.reload': async () => {
      return { added: 0, removed: 0, updated: 0 };
    },
  };
}
