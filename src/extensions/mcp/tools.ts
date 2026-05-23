import type { Tool } from '../../application/ports/tool';
import type { ToolCatalog } from '../../application/ports/tool-catalog';
import type { ToolContext } from '../../application/ports/tool-context';
import type { McpManager } from './manager';
import { McpToolAdapter } from './tool-adapter';
import type { McpPromptRegistry } from './prompt-registry';
import { persistServerConfig, removeServerConfig } from './server-persistence';
import type { McpServerConfig } from '../../config/types';
import { mcpServerConfigCodec } from '../../application/contracts/mcp-server-config';

export function createMcpListServersTool(manager: McpManager): Tool {
  return {
    name: 'mcp_list_servers',
    description: 'List all configured MCP servers and their connection status',
    parameters: { type: 'object', properties: {} },
    execute: async (_ctx: ToolContext, _params: Record<string, unknown>) => {
      const states = manager.getConnectionStates();
      if (states.size === 0) return 'No MCP servers configured.';
      const lines: string[] = [];
      for (const [name, state] of states) {
        const icon = state.status === 'connected' ? '\u2713' : state.status === 'error' ? '\u2717' : state.status === 'connecting' ? '\u2026' : '\u25CB';
        const detail = state.status === 'connected' ? `${state.capabilities.tools.length} tools, ${state.capabilities.resources.length} resources, ${state.capabilities.prompts.length} prompts` : state.status === 'error' ? state.message : '';
        lines.push(`${icon} ${name} [${state.status}]${detail ? ` \u2014 ${detail}` : ''}`);
      }
      return lines.join('\n');
    },
    readonly: true,
  };
}

export function createMcpAddServerTool(manager: McpManager, catalog: ToolCatalog, promptRegistry: McpPromptRegistry): Tool {
  return {
    name: 'mcp_add_server',
    description: 'Connect to a new MCP server and register its tools and prompts. Persisted to user settings for future sessions.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique server name (used for tool prefix)' },
        transport: { type: 'string', enum: ['stdio', 'sse', 'streamable-http'] },
        command: { type: 'string', description: 'Shell command (stdio transport only)' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (stdio transport only)' },
        url: { type: 'string', description: 'Server URL (sse / streamable-http transport)' },
        headers: { type: 'object', description: 'HTTP headers (optional)' },
        env: { type: 'object', description: 'Environment variables (optional)' },
      },
      required: ['name', 'transport'],
    },
    execute: async (_ctx: ToolContext, params: Record<string, unknown>) => {
      const parsed = mcpServerConfigCodec.safeDecode(params);
      if (!parsed.ok) {
        return `Error: invalid MCP server configuration:\n${parsed.error}`;
      }
      const config = parsed.value as McpServerConfig;
      if (manager.hasServer(config.name)) {
        return `Error: MCP server '${config.name}' already connected. Use mcp_remove_server first to remove it.`;
      }
      await manager.connectServer(config);
      void persistServerConfig(config);

      const tools = manager.getServerTools(config.name);
      for (const toolDef of tools) {
        const adapter = new McpToolAdapter(manager, config.name, toolDef);
        catalog.register(adapter.toTool());
      }

      const prompts = manager.getServerPrompts(config.name);
      for (const promptDef of prompts) {
        promptRegistry.registerAsTool(config.name, promptDef, catalog);
      }

      return `Connected to '${config.name}': ${tools.length} tools, ${prompts.length} prompts registered.`;
    },
  };
}

export function createMcpRemoveServerTool(manager: McpManager, catalog: ToolCatalog): Tool {
  return {
    name: 'mcp_remove_server',
    description: 'Disconnect and unregister an MCP server. Session-only.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Server name to remove' } },
      required: ['name'],
    },
    execute: async (_ctx: ToolContext, params: Record<string, unknown>) => {
      const name = String(params.name);
      if (!manager.hasServer(name)) return `Error: MCP server '${name}' not found.`;
      const prefix = `mcp__${name}__`;
      for (const tool of catalog.list()) {
        if (tool.name.startsWith(prefix)) catalog.unregister(tool.name);
      }
      await manager.removeServer(name);
      void removeServerConfig(name);
      return `Removed MCP server '${name}'.`;
    },
  };
}

export function createMcpReadResourceTool(manager: McpManager): Tool {
  return {
    name: 'mcp_read_resource',
    description: 'Read the contents of an MCP resource by server name and URI.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name' },
        uri: { type: 'string', description: 'Resource URI to read' },
      },
      required: ['server', 'uri'],
    },
    execute: async (_ctx: ToolContext, params: Record<string, unknown>) => {
      const server = String(params.server);
      const uri = String(params.uri);
      const result = await manager.readResource(server, uri);
      const callResult = result as { contents?: Array<{ text?: string; blob?: string; uri?: string; mimeType?: string }> };
      if (!callResult.contents || callResult.contents.length === 0) return `Resource '${uri}' returned empty contents.`;
      return callResult.contents.map((c) => c.text ?? `[binary data: ${c.mimeType ?? 'unknown'}, uri: ${c.uri}]`).join('\n\n');
    },
    readonly: true,
  };
}
