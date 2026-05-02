import type { SlashCommand } from '../command-registry';
import type { CommandHandlerContext } from '../types';

const MCP_COMMAND_DEFS: Omit<SlashCommand, 'handler'>[] = [
  { name: 'mcp', description: 'Show MCP server connection status', type: 'builtin' },
  { name: 'mcp-add', description: 'Add an MCP server (JSON config)', type: 'builtin' },
  { name: 'mcp-remove', description: 'Remove an MCP server', type: 'builtin' },
  { name: 'mcp-connect', description: 'Connect to an MCP server', type: 'builtin' },
  { name: 'mcp-disconnect', description: 'Disconnect from an MCP server', type: 'builtin' },
];

export function getMcpCommands(): SlashCommand[] {
  return MCP_COMMAND_DEFS.map(cmd => ({
    ...cmd,
    handler: async (ctx: CommandHandlerContext) => {
      const manager = ctx.mcpManager;
      if (!manager) {
        ctx.onOutput('MCP is not enabled. Set mcp.enabled: true in settings.json.');
        return;
      }

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
          ctx.onOutput('Usage: /mcp-add {"name":"myserver","transport":"stdio","command":"npx","args":["-y","@myscope/server"]}');
          return;
        }
        case 'mcp-remove': {
          ctx.onOutput('Usage: /mcp-remove <server-name>');
          return;
        }
        case 'mcp-connect': {
          ctx.onOutput('Usage: /mcp-connect <server-name>');
          return;
        }
        case 'mcp-disconnect': {
          ctx.onOutput('Usage: /mcp-disconnect <server-name>');
          return;
        }
      }
    },
  }));
}
