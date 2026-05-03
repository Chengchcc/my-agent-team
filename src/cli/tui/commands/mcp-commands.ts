import type { SlashCommand } from '../command-registry';
import type { CommandHandlerContext } from '../types';
import { McpToolAdapter } from '../../../mcp/tool-adapter';
import { getMcpManagerInstance, getMcpToolRegistry, getMcpPromptRegistry } from '../../../mcp/index';
import type { McpServerConfig } from '../../../config/types';

const MCP_COMMAND_DEFS = [
  { name: 'mcp', description: 'Show MCP server connection status' },
  { name: 'mcp-add', description: 'Add an MCP server (JSON config)' },
  { name: 'mcp-remove', description: 'Remove an MCP server' },
  { name: 'mcp-connect', description: 'Connect to an MCP server' },
  { name: 'mcp-disconnect', description: 'Disconnect from an MCP server' },
] as const;

export function getMcpCommands(): SlashCommand[] {
  return MCP_COMMAND_DEFS.map(cmd => ({
    name: cmd.name,
    description: cmd.description,
    type: 'builtin' as const,
    handler: async (ctx: CommandHandlerContext) => {
      const manager = getMcpManagerInstance();
      if (!manager) {
        ctx.onOutput('MCP is not enabled. Set mcp.enabled: true in settings.yml.');
        return;
      }

      const registry = getMcpToolRegistry();
      const promptReg = getMcpPromptRegistry();

      switch (cmd.name) {
        case 'mcp': {
          const states = manager.getConnectionStates();
          if (states.size === 0) {
            ctx.onOutput('No MCP servers configured or connected.');
            return;
          }
          const lines: string[] = ['MCP Servers:'];
          for (const [name, state] of states) {
            const icon = state.status === 'connected' ? '[connected]'
              : state.status === 'error' ? '[error]'
              : state.status === 'connecting' ? '[connecting]'
              : '[disconnected]';
            const detail = state.status === 'connected'
              ? ` ${state.capabilities.tools.length}t/${state.capabilities.resources.length}r/${state.capabilities.prompts.length}p`
              : state.status === 'error' ? ` ${state.message}` : '';
            lines.push(`  ${name} ${icon}${detail}`);
          }
          ctx.onOutput(lines.join('\n'));
          break;
        }
        case 'mcp-add': {
          if (!ctx.args) {
            ctx.onOutput('Usage: /mcp-add {"name":"myserver","transport":"stdio","command":"npx","args":["-y","@scope/server"]}');
            return;
          }
          let parsed: McpServerConfig;
          try {
            parsed = JSON.parse(ctx.args) as McpServerConfig;
          } catch {
            ctx.onOutput('Error: invalid JSON config. Example: {"name":"myserver","transport":"stdio","command":"npx","args":["-y","@scope/server"]}');
            return;
          }
          if (!parsed.name || !parsed.transport) {
            ctx.onOutput('Error: config must include "name" and "transport" fields.');
            return;
          }

          try {
            await manager.connectServer(parsed);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.onOutput(`Error connecting to '${parsed.name}': ${msg}`);
            return;
          }

          const tools = manager.getServerTools(parsed.name);
          if (registry) {
            for (const toolDef of tools) {
              registry.register(new McpToolAdapter(manager, parsed.name, toolDef));
            }
          }

          if (promptReg) {
            const prompts = manager.getServerPrompts(parsed.name);
            for (const promptDef of prompts) {
              promptReg.registerAsTool(parsed.name, promptDef, registry!);
            }
          }

          ctx.onOutput(`Connected to '${parsed.name}': ${tools.length} tools registered.`);
          break;
        }
        case 'mcp-remove': {
          const name = ctx.args.trim();
          if (!name) {
            ctx.onOutput('Usage: /mcp-remove <server-name>');
            return;
          }

          if (!manager.hasServer(name)) {
            ctx.onOutput(`Error: MCP server '${name}' not found.`);
            return;
          }

          if (registry) {
            const prefix = `mcp__${name}__`;
            for (const [toolName] of registry.tools) {
              if (toolName.startsWith(prefix)) {
                registry.unregister(toolName);
              }
            }
          }

          await manager.removeServer(name);
          ctx.onOutput(`Removed MCP server '${name}'.`);
          break;
        }
        case 'mcp-connect': {
          const name = ctx.args.trim();
          if (!name) {
            ctx.onOutput('Usage: /mcp-connect <server-name>');
            return;
          }

          if (!manager.hasServer(name)) {
            ctx.onOutput(`Error: MCP server '${name}' not found. Use /mcp-add to add a new server.`);
            return;
          }

          const states = manager.getConnectionStates();
          const state = states.get(name);
          if (state?.status === 'connected') {
            ctx.onOutput(`Server '${name}' is already connected.`);
            return;
          }

          ctx.onOutput(`Cannot reconnect '${name}' — config not cached. Use /mcp-remove ${name} then /mcp-add.`);
          break;
        }
        case 'mcp-disconnect': {
          const name = ctx.args.trim();
          if (!name) {
            ctx.onOutput('Usage: /mcp-disconnect <server-name>');
            return;
          }

          if (!manager.hasServer(name)) {
            ctx.onOutput(`Error: MCP server '${name}' not found.`);
            return;
          }

          await manager.disconnectServer(name);
          ctx.onOutput(`Disconnected from '${name}' (tools remain registered, use /mcp-remove to unregister).`);
          break;
        }
      }
    },
  }));
}
