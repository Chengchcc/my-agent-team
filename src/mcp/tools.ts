import type { Tool, ToolImplementation } from '../types';
import type { ToolContext } from '../agent/tool-dispatch/types';
import type { McpManager } from './manager';
import type { ToolRegistry } from '../agent/tool-registry';
import type { McpPromptRegistry } from './prompt-registry';
import { McpToolAdapter } from './tool-adapter';
import type { McpServerConfig } from '../config/types';

export class McpListServersTool implements ToolImplementation {
  constructor(private manager: McpManager) {}

  getDefinition(): Tool {
    return {
      name: 'mcp_list_servers',
      description: 'List all configured MCP servers and their connection status',
      parameters: { type: 'object', properties: {} },
    };
  }

  async execute(_params: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
    const states = this.manager.getConnectionStates();
    if (states.size === 0) return 'No MCP servers configured.';

    const lines: string[] = [];
    for (const [name, state] of states) {
      const icon =
        state.status === 'connected' ? '\u2713'
        : state.status === 'error' ? '\u2717'
        : state.status === 'connecting' ? '\u2026'
        : '\u25CB';
      const detail =
        state.status === 'connected'
          ? `${state.capabilities.tools.length} tools, ${state.capabilities.resources.length} resources, ${state.capabilities.prompts.length} prompts`
          : state.status === 'error' ? state.message
          : '';
      lines.push(`${icon} ${name} [${state.status}]${detail ? ` \u2014 ${detail}` : ''}`);
    }
    return lines.join('\n');
  }
}

export class McpAddServerTool implements ToolImplementation {
  constructor(
    private manager: McpManager,
    private toolRegistry: ToolRegistry,
    private promptRegistry: McpPromptRegistry,
  ) {}

  getDefinition(): Tool {
    return {
      name: 'mcp_add_server',
      description:
        'Connect to a new MCP server and register its tools and prompts. Session-only (not persisted to settings).',
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
    };
  }

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
    const config = params as unknown as McpServerConfig;

    if (this.manager.hasServer(config.name)) {
      return `Error: MCP server '${config.name}' already connected. Use mcp_remove_server first to remove it.`;
    }

    await this.manager.connectServer(config);

    const tools = this.manager.getServerTools(config.name);
    for (const toolDef of tools) {
      this.toolRegistry.register(new McpToolAdapter(this.manager, config.name, toolDef));
    }

    const prompts = this.manager.getServerPrompts(config.name);
    for (const promptDef of prompts) {
      this.promptRegistry.registerAsTool(config.name, promptDef, this.toolRegistry);
    }

    return `Connected to '${config.name}': ${tools.length} tools, ${prompts.length} prompts registered.`;
  }
}

export class McpRemoveServerTool implements ToolImplementation {
  constructor(
    private manager: McpManager,
    private toolRegistry: ToolRegistry,
  ) {}

  getDefinition(): Tool {
    return {
      name: 'mcp_remove_server',
      description: 'Disconnect and unregister an MCP server. Session-only.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Server name to remove' },
        },
        required: ['name'],
      },
    };
  }

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
    const name = String(params.name);

    if (!this.manager.hasServer(name)) {
      return `Error: MCP server '${name}' not found.`;
    }

    const prefix = `mcp__${name}__`;
    for (const [toolName] of this.toolRegistry.tools) {
      if (toolName.startsWith(prefix)) {
        this.toolRegistry.unregister(toolName);
      }
    }

    await this.manager.removeServer(name);
    return `Removed MCP server '${name}'.`;
  }
}
