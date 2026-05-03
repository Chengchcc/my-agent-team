import type { SlashCommand } from '../command-registry';
import type { CommandHandlerContext } from '../types';
import type { McpManager } from '../../../mcp/manager';
import type { ToolRegistry } from '../../../agent/tool-registry';
import type { McpPromptRegistry } from '../../../mcp/prompt-registry';
import { McpToolAdapter } from '../../../mcp/tool-adapter';
import { getMcpManagerInstance, getMcpToolRegistry, getMcpPromptRegistry } from '../../../mcp/index';
import { persistServerConfig, removeServerConfig } from '../../../mcp/server-persistence';
import { debugLog } from '../../../utils/debug';
import type { McpServerConfig } from '../../../config/types';

const MCP_COMMAND_DEFS = [
  { name: 'mcp', description: 'Show MCP server connection status' },
  { name: 'mcp-add', description: 'Add an MCP server (JSON config)' },
  { name: 'mcp-remove', description: 'Remove an MCP server' },
  { name: 'mcp-connect', description: 'Connect to an MCP server' },
  { name: 'mcp-disconnect', description: 'Disconnect from an MCP server' },
] as const;

function handleMcpStatus(ctx: CommandHandlerContext, manager: McpManager): void {
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
}

async function handleMcpAdd(
  ctx: CommandHandlerContext,
  manager: McpManager,
  registry: ToolRegistry | null,
  promptReg: McpPromptRegistry | null,
): Promise<void> {
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

  await manager.connectServer(parsed);

  // Persist to user settings so it survives restarts
  debugLog(`[mcp-commands] Persisting server '${parsed.name}' to settings`);
  persistServerConfig(parsed)
    .then(() => debugLog(`[mcp-commands] Persisted '${parsed.name}'`))
    .catch(err => debugLog(`[mcp-commands] Persist failed for '${parsed.name}': ${err}`));

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
}

function assertMcpEnabled(ctx: CommandHandlerContext): McpManager | null {
  const manager = getMcpManagerInstance();
  if (!manager) {
    debugLog('[mcp-commands] assertMcpEnabled: singleton is null — MCP not initialized');
    ctx.onOutput('MCP is not enabled. Set mcp.enabled: true in settings.yml.');
  }
  return manager;
}

async function handleMcpRemove(
  ctx: CommandHandlerContext,
  manager: McpManager,
  registry: ToolRegistry | null,
): Promise<void> {
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
  void removeServerConfig(name);
  ctx.onOutput(`Removed MCP server '${name}'.`);
}

function handleMcpConnect(ctx: CommandHandlerContext, manager: McpManager): void {
  const name = ctx.args.trim();
  if (!name) { ctx.onOutput('Usage: /mcp-connect <server-name>'); return; }
  if (!manager.hasServer(name)) {
    ctx.onOutput(`Error: MCP server '${name}' not found. Use /mcp-add to add a new server.`);
    return;
  }
  const state = manager.getConnectionStates().get(name);
  if (state?.status === 'connected') {
    ctx.onOutput(`Server '${name}' is already connected.`);
    return;
  }
  ctx.onOutput(`Cannot reconnect '${name}' — config not cached. Use /mcp-remove ${name} then /mcp-add.`);
}

async function handleMcpDisconnect(ctx: CommandHandlerContext, manager: McpManager): Promise<void> {
  const name = ctx.args.trim();
  if (!name) { ctx.onOutput('Usage: /mcp-disconnect <server-name>'); return; }
  if (!manager.hasServer(name)) {
    ctx.onOutput(`Error: MCP server '${name}' not found.`);
    return;
  }
  await manager.disconnectServer(name);
  ctx.onOutput(`Disconnected from '${name}' (tools remain registered, use /mcp-remove to unregister).`);
}

export function getMcpCommands(): SlashCommand[] {
  return MCP_COMMAND_DEFS.map(cmd => ({
    name: cmd.name,
    description: cmd.description,
    type: 'builtin' as const,
    handler: async (ctx: CommandHandlerContext) => {
      const manager = assertMcpEnabled(ctx);
      if (!manager) return;

      const registry = getMcpToolRegistry();
      const promptReg = getMcpPromptRegistry();

      switch (cmd.name) {
        case 'mcp': return handleMcpStatus(ctx, manager);
        case 'mcp-add': return handleMcpAdd(ctx, manager, registry, promptReg);
        case 'mcp-remove': return handleMcpRemove(ctx, manager, registry);
        case 'mcp-connect': return handleMcpConnect(ctx, manager);
        case 'mcp-disconnect': return handleMcpDisconnect(ctx, manager);
      }
    },
  }));
}
