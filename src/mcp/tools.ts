import { z } from 'zod';
import type { Tool, ToolImplementation } from '../types';
import type { ToolContext } from '../agent/tool-dispatch/types';
import type { McpManager } from './manager';
import type { ToolRegistry } from '../agent/tool-registry';
import type { McpPromptRegistry } from './prompt-registry';
import { McpToolAdapter } from './tool-adapter';
import { persistServerConfig, removeServerConfig } from './server-persistence';
import type { McpServerConfig } from '../config/types';

const mcpServerConfigSchema = z.object({
  name: z.string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Name must contain only alphanumeric chars, dashes, and underscores')
    .refine(s => !s.includes('__'), 'Name must not contain "__" (reserved separator)'),
  transport: z.enum(['stdio', 'sse', 'streamable-http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  autoStart: z.boolean().optional(),
}).refine(
  data => data.transport !== 'stdio' || !!data.command,
  { message: 'command is required for stdio transport', path: ['command'] },
).refine(
  data => data.transport === 'stdio' || !!data.url,
  { message: 'url is required for sse/streamable-http transport', path: ['url'] },
).refine(
  data => data.transport === 'stdio' || (() => { try { new URL(data.url!); return true; } catch { return false; } })(),
  { message: 'url must be a valid URL', path: ['url'] },
);

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
        'Connect to a new MCP server and register its tools and prompts. Persisted to user settings for future sessions.',
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
    const parsed = mcpServerConfigSchema.safeParse(params);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      return `Error: invalid MCP server configuration:\n${issues}`;
    }
    const config = parsed.data as McpServerConfig;

    if (this.manager.hasServer(config.name)) {
      return `Error: MCP server '${config.name}' already connected. Use mcp_remove_server first to remove it.`;
    }

    await this.manager.connectServer(config);

    void persistServerConfig(config);

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
    void removeServerConfig(name);
    return `Removed MCP server '${name}'.`;
  }
}

/** Gives the LLM the ability to read MCP resource contents by URI. */
export class McpReadResourceTool implements ToolImplementation {
  constructor(private manager: McpManager) {}

  getDefinition(): Tool {
    return {
      name: 'mcp_read_resource',
      description:
        'Read the contents of an MCP resource by server name and URI. ' +
        'Use this after mcp_list_servers or the resource catalog to view specific resource data.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name' },
          uri: { type: 'string', description: 'Resource URI to read' },
        },
        required: ['server', 'uri'],
      },
    };
  }

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
    const server = String(params.server);
    const uri = String(params.uri);

    const result = await this.manager.readResource(server, uri);
    const callResult = result as {
      contents?: Array<{ text?: string; blob?: string; uri?: string; mimeType?: string }>;
    };

    if (!callResult.contents || callResult.contents.length === 0) {
      return `Resource '${uri}' returned empty contents.`;
    }

    return callResult.contents
      .map(c => c.text ?? `[binary data: ${c.mimeType ?? 'unknown'}, uri: ${c.uri}]`)
      .join('\n\n');
  }
}
