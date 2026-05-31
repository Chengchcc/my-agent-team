import { defineExtension } from '../../kernel/define-extension';
import { McpManager } from './manager';
import type { McpServerConfig } from '../../config/types';
import { McpPromptRegistry } from './prompt-registry';
import {
  createMcpListServersTool,
  createMcpAddServerTool,
  createMcpRemoveServerTool,
  createMcpReadResourceTool,
} from './tools';
import { createMcpRpc } from './rpc';
import type { CliManifest } from '../../cli/cli-types'
import type { AssertHasCliManifest } from '../../cli/assert-cli-bearing'
import { requireRpc } from '../../cli/cli-runtime'

const MCP_COLUMNS = { name: 20, status: 14 } as const

export const cliManifest: CliManifest = {
  name: 'mcp',
  description: 'Manage MCP (Model Context Protocol) servers',
  needs: ['rpc'] as const,
  usage: [
    '  my-agent mcp list',
    '  my-agent mcp add <name> --transport stdio|sse|http [--command <cmd>] [--url <url>]',
    '  my-agent mcp remove <name>',
    '  my-agent mcp reload',
  ].join('\n'),
  handler: async (argv, ctx) => {
    const rpc = requireRpc(ctx)
    const sub = argv[0]
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- default handles undefined
    switch (sub) {
      case 'list': {
        const result = await rpc('mcp.list')
        const data = result as { servers: Array<{ name: string; status: string; capabilities: { tools: number; resources: number; prompts: number }; message?: string }> }
        if (data.servers.length === 0) {
          ctx.out('No MCP servers configured.\n')
          return
        }
        for (const s of data.servers) {
          const caps = `${s.capabilities.tools}t/${s.capabilities.resources}r/${s.capabilities.prompts}p`
          ctx.out(`${s.name.padEnd(MCP_COLUMNS.name)} ${s.status.padEnd(MCP_COLUMNS.status)} ${caps}\n`)
        }
        return
      }
      case 'add': {
        if (!argv[1]) { ctx.err('missing <name>\n'); process.exit(2) }
        const transportIdx = argv.indexOf('--transport')
        const transport = transportIdx >= 0 ? argv[transportIdx + 1] : undefined
        if (!transport) { ctx.err('--transport is required\n'); process.exit(2) }
        const commandIdx = argv.indexOf('--command')
        const urlIdx = argv.indexOf('--url')
        const config: Record<string, unknown> = {
          name: argv[1],
          transport,
        }
        if (commandIdx >= 0) config.command = argv[commandIdx + 1]
        if (urlIdx >= 0) config.url = argv[urlIdx + 1]
        await rpc('mcp.add', { config })
        ctx.out(`Server "${argv[1]}" added.\n`)
        return
      }
      case 'remove': {
        if (!argv[1]) { ctx.err('missing <name>\n'); process.exit(2) }
        await rpc('mcp.remove', { name: argv[1] })
        ctx.out(`Server "${argv[1]}" removed.\n`)
        return
      }
      case 'reload': {
        const result = await rpc('mcp.reload')
        const data = result as { added: number; removed: number; updated: number }
        ctx.out(`Reloaded: ${data.added} added, ${data.removed} removed, ${data.updated} updated\n`)
        return
      }
      default:
        ctx.err(`unknown subcommand: ${sub ?? '(none)'}\n`)
        ctx.err(cliManifest.usage + '\n')
        process.exit(2)
    }
  },
}

// Compile-time assertion: this module exports cliManifest
/**
 * @internal — compile-time satisfies check that this module exposes a CliManifest;
 * has no runtime consumer by design.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- typeof import pattern required for AssertHasCliManifest
export type _CheckCliManifest = AssertHasCliManifest<typeof import('./index')>

export default () =>
  defineExtension({
    name: 'mcp',
    enforce: 'normal',
    dependsOn: ['tool-catalog'],

    apply: (ctx) => {
      const manager = new McpManager({
        toolTimeoutMs: 30_000,
        reconnectAttempts: 3,
        reconnectDelayMs: 1_000,
        maxReconnectAttempts: 3,
      }, ctx.logger);

      const catalog = ctx.extensions.get('tool-catalog.catalog');
      const promptRegistry = new McpPromptRegistry(manager);

      // Register static MCP management tools
      catalog.register(createMcpListServersTool(manager));
      catalog.register(createMcpReadResourceTool(manager));
      catalog.register(createMcpAddServerTool(manager, catalog, promptRegistry));
      catalog.register(createMcpRemoveServerTool(manager, catalog));

      return {
        provide: {
          'mcp.manager': () => manager,
        },

        hooks: {
          kernelReady: {
            enforce: 'normal',
            fn: async () => {
              const mcpConfig = ctx.config.get<{ servers?: Array<{ name: string; transport: string; autoStart?: boolean }> } | undefined>(
                'mcp',
                (raw) => raw as { servers?: Array<{ name: string; transport: string; autoStart?: boolean }> } | undefined,
              );
              const servers = mcpConfig?.servers ?? [];
              const autoServers = servers.filter((s) => s.autoStart !== false);

              if (autoServers.length > 0) {
                ctx.logger.info('mcp', `Auto-starting ${autoServers.length} MCP server(s)`);
                for (const server of autoServers) {
                  try {
                    await manager.connectServer(server as McpServerConfig);
                    ctx.logger.info('mcp', `MCP server '${server.name}' auto-started`);
                  } catch (err) {
                    ctx.logger.warn('mcp', `Failed to auto-start MCP server '${server.name}': ${String(err)}`);
                  }
                }
              } else {
                ctx.logger.info('mcp', 'MCP manager ready (no auto-start servers configured)');
              }
            },
          },

          onShutdown: {
            enforce: 'pre',
            fn: async () => {
              await manager.shutdown();
            },
          },
        },

        rpc: createMcpRpc(manager, ctx.bus),

        dispose: () => manager.shutdown(),
      };
    },
  });
