import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '../config/types';
import type {
  McpConnectionState,
  McpToolDef,
  McpResourceDef,
  McpPromptDef,
  McpPromptArgument,
  McpPromptResult,
  McpClientEntry,
} from './types';
import { debugLog } from '../utils/debug';

interface McpManagerOptions {
  toolTimeoutMs: number;
  reconnectAttempts: number;
  reconnectDelayMs: number;
}

export class McpManager {
  private _servers = new Map<string, McpClientEntry>();

  private _options: McpManagerOptions;

  constructor(options: McpManagerOptions) {
    this._options = options;
  }

  /** Connect all servers with autoStart !== false. Does NOT register tools — caller must do that. */
  async start(servers: McpServerConfig[]): Promise<void> {
    const targets = servers.filter(s => s.autoStart !== false);
    const results = await Promise.allSettled(
      targets.map(s => this.connectServer(s)),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        debugLog(`[McpManager] Failed to connect '${targets[i]!.name}': ${result.reason}`);
      }
    }
  }

  async connectServer(config: McpServerConfig): Promise<void> {
    if (this._servers.has(config.name)) {
      throw new Error(`MCP server '${config.name}' already connected`);
    }

    this._servers.set(config.name, {
      config,
      client: null,
      transport: null,
      state: { status: 'connecting' },
    });

    try {
      const transport = this._createTransport(config);
      const client = new Client(
        { name: 'my-agent', version: '0.0.0' },
        { capabilities: {} },
      );

      await client.connect(transport as Transport);

      const tools = await this._listTools(client);
      const resources = await this._listResources(client);
      const prompts = await this._listPrompts(client);

      this._servers.set(config.name, {
        config,
        client,
        transport,
        state: {
          status: 'connected',
          capabilities: { tools, resources, prompts },
          startedAt: Date.now(),
        },
      });

      debugLog(`[McpManager] Connected to '${config.name}': ${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._servers.set(config.name, {
        config,
        client: null,
        transport: null,
        state: { status: 'error', message, since: Date.now() },
      });
      throw err;
    }
  }

  async disconnectServer(name: string): Promise<void> {
    const entry = this._servers.get(name);
    if (!entry) return;

    try {
      if (entry.client) {
        await this._getClient(name).close();
      }
    } catch (err) {
      debugLog(`[McpManager] Error closing '${name}': ${err instanceof Error ? err.message : String(err)}`);
    }

    this._servers.set(name, {
      ...entry,
      client: null,
      transport: null,
      state: { status: 'disconnected' },
    });
  }

  async removeServer(name: string): Promise<void> {
    await this.disconnectServer(name);
    this._servers.delete(name);
  }

  async shutdown(): Promise<void> {
    const names = Array.from(this._servers.keys());
    await Promise.allSettled(names.map(n => this.disconnectServer(n)));
  }

  hasServer(name: string): boolean {
    return this._servers.has(name);
  }

  getConnectionStates(): ReadonlyMap<string, McpConnectionState> {
    const result = new Map<string, McpConnectionState>();
    for (const [name, entry] of this._servers) {
      result.set(name, entry.state);
    }
    return result;
  }

  getAllTools(): Array<{ serverName: string; tool: McpToolDef }> {
    const result: Array<{ serverName: string; tool: McpToolDef }> = [];
    for (const [name, entry] of this._servers) {
      if (entry.state.status === 'connected') {
        for (const tool of entry.state.capabilities.tools) {
          result.push({ serverName: name, tool });
        }
      }
    }
    return result;
  }

  getAllResources(): Array<{ serverName: string; resource: McpResourceDef }> {
    const result: Array<{ serverName: string; resource: McpResourceDef }> = [];
    for (const [name, entry] of this._servers) {
      if (entry.state.status === 'connected') {
        for (const resource of entry.state.capabilities.resources) {
          result.push({ serverName: name, resource });
        }
      }
    }
    return result;
  }

  getAllPrompts(): Array<{ serverName: string; prompt: McpPromptDef }> {
    const result: Array<{ serverName: string; prompt: McpPromptDef }> = [];
    for (const [name, entry] of this._servers) {
      if (entry.state.status === 'connected') {
        for (const prompt of entry.state.capabilities.prompts) {
          result.push({ serverName: name, prompt });
        }
      }
    }
    return result;
  }

  getServerTools(name: string): McpToolDef[] {
    const entry = this._servers.get(name);
    if (entry?.state.status === 'connected') {
      return entry.state.capabilities.tools;
    }
    return [];
  }

  getServerPrompts(name: string): McpPromptDef[] {
    const entry = this._servers.get(name);
    if (entry?.state.status === 'connected') {
      return entry.state.capabilities.prompts;
    }
    return [];
  }

  async executeTool(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const client = this._getClient(serverName);
    const result = client.callTool({ name: toolName, arguments: params });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP tool '${toolName}' timed out after ${this._options.toolTimeoutMs}ms`)), this._options.toolTimeoutMs),
    );
    return Promise.race([result, timeout]);
  }

  async readResource(serverName: string, uri: string): Promise<unknown> {
    const client = this._getClient(serverName);
    return client.readResource({ uri });
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    args: Record<string, string>,
  ): Promise<McpPromptResult> {
    const client = this._getClient(serverName);
    const result = await client.getPrompt({ name: promptName, arguments: args });
    return result as unknown as McpPromptResult;
  }

  private _createTransport(config: McpServerConfig) {
    switch (config.transport) {
      case 'stdio':
        return new StdioClientTransport({
          command: config.command!,
          ...(config.args ? { args: config.args } : {}),
          ...(config.env ? { env: config.env } : {}),
        });
      case 'sse': {
        const sseOpts = config.headers ? { requestInit: { headers: config.headers } } : {};
        return new SSEClientTransport(new URL(config.url!), sseOpts);
      }
      case 'streamable-http': {
        const httpOpts = config.headers ? { requestInit: { headers: config.headers } } : {};
        return new StreamableHTTPClientTransport(new URL(config.url!), httpOpts);
      }
      default:
        throw new Error(`Unknown transport: ${config.transport}`);
    }
  }

  private async _listTools(client: Client): Promise<McpToolDef[]> {
    const result = await client.listTools();
    const mapped: McpToolDef[] = [];
    for (const t of result.tools || []) {
      const def: McpToolDef = {
        name: t.name,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      };
      if (t.description !== undefined) {
        def.description = t.description;
      }
      mapped.push(def);
    }
    return mapped;
  }

  private async _listResources(client: Client): Promise<McpResourceDef[]> {
    try {
      const result = await client.listResources();
      const mapped: McpResourceDef[] = [];
      for (const r of result.resources || []) {
        const def: McpResourceDef = {
          uri: r.uri,
          name: r.name,
        };
        if (r.description !== undefined) {
          def.description = r.description;
        }
        if (r.mimeType !== undefined) {
          def.mimeType = r.mimeType;
        }
        mapped.push(def);
      }
      return mapped;
    } catch (err) {
      debugLog(`[McpManager] _listResources failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async _listPrompts(client: Client): Promise<McpPromptDef[]> {
    try {
      const result = await client.listPrompts();
      const mapped: McpPromptDef[] = [];
      for (const p of result.prompts || []) {
        const def: McpPromptDef = {
          name: p.name,
        };
        if (p.description !== undefined) {
          def.description = p.description;
        }
        if (p.arguments !== undefined) {
          const args: McpPromptArgument[] = [];
          for (const a of p.arguments) {
            const arg: McpPromptArgument = { name: a.name };
            if (a.description !== undefined) arg.description = a.description;
            if (a.required !== undefined) arg.required = a.required;
            args.push(arg);
          }
          def.arguments = args;
        }
        mapped.push(def);
      }
      return mapped;
    } catch (err) {
      debugLog(`[McpManager] _listPrompts failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Resolves a connected server entry and returns its SDK Client, or throws. */
  private _getClient(serverName: string): Client {
    const entry = this._servers.get(serverName);
    if (!entry || entry.state.status !== 'connected') {
      throw new Error(`MCP server '${serverName}' is not connected`);
    }
    return entry.client as Client;
  }
}
