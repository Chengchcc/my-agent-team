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
import pLimit from 'p-limit';
import { debugLog } from '../utils/debug';

const MAX_STDIO_CONNECTIONS = 4;
const CONNECT_TIMEOUT_MS = 10_000;

interface McpManagerOptions {
  toolTimeoutMs: number;
  reconnectAttempts: number;
  reconnectDelayMs: number;
  maxReconnectAttempts: number;
}

export class McpManager {
  private _servers = new Map<string, McpClientEntry>();

  private _reconnectAttempts = new Map<string, number>();

  private _options: McpManagerOptions;

  constructor(options: McpManagerOptions) {
    this._options = options;
  }

  /** Connect all servers with autoStart !== false. Returns immediately — caller must use onServerReady for per-server results. */
  start(servers: McpServerConfig[]): void {
    const targets = servers.filter(s => s.autoStart !== false);
    const stdioServers = targets.filter(s => s.transport === 'stdio');
    const httpServers = targets.filter(s => s.transport !== 'stdio');

    if (targets.length === 0) {
      this._onReady?.();
      return;
    }

    const limit = pLimit(MAX_STDIO_CONNECTIONS);
    const allServers = [...httpServers, ...stdioServers];
    const promises = [
      ...httpServers.map(s => this.connectServer(s)),
      ...stdioServers.map(s => limit(() => this.connectServer(s))),
    ];

    Promise.allSettled(promises).then(results => {
      for (let i = 0; i < results.length; i++) {
        const name = allServers[i]!.name;
        const result = results[i]!;
        if (result.status === 'rejected') {
          debugLog(`[McpManager] Failed to connect '${name}': ${result.reason}`);
        }
      }
      this._onReady?.();
    });
  }

  /** Callback invoked after all initial autoStart servers finish connecting (success or failure). */
  private _onReady?: () => void;

  onReady(cb: () => void): void {
    this._onReady = cb;
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

    let client: Client | null = null;

    try {
      const transport = this._createTransport(config);
      client = new Client(
        { name: 'my-agent', version: '0.0.0' },
        { capabilities: {} },
      );

      transport.onclose = () => {
        const entry = this._servers.get(config.name);
        if (entry?.state.status === 'connected') {
          debugLog(`[McpManager] '${config.name}' connection closed unexpectedly`);
          this._servers.set(config.name, {
            ...entry,
            client: null,
            transport: null,
            state: { status: 'error', message: 'Connection closed', since: Date.now() },
          });
          void this._reconnect(config.name);
        }
      };

      await this._withTimeout(
        client.connect(transport as Transport),
        CONNECT_TIMEOUT_MS,
        `connect to '${config.name}'`,
      );

      const tools = await this._withTimeout(
        this._listTools(client),
        CONNECT_TIMEOUT_MS,
        `list tools from '${config.name}'`,
      );
      const resources = await this._withTimeout(
        this._listResources(client),
        CONNECT_TIMEOUT_MS,
        `list resources from '${config.name}'`,
      );
      const prompts = await this._withTimeout(
        this._listPrompts(client),
        CONNECT_TIMEOUT_MS,
        `list prompts from '${config.name}'`,
      );

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
      if (client) {
        try { await client.close(); } catch { /* ignore close errors */ }
      }
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

    const client = entry.client as Client | null;

    // Mark disconnected BEFORE close so transport.onclose won't attempt reconnect
    this._servers.set(name, {
      ...entry,
      client: null,
      transport: null,
      state: { status: 'disconnected' },
    });

    // Reset reconnect counter on manual disconnect
    this._reconnectAttempts.delete(name);

    if (client) {
      try {
        await client.close();
      } catch (err) {
        debugLog(`[McpManager] Error closing '${name}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this._getClient(serverName);
    const options = {
      timeout: this._options.toolTimeoutMs,
      ...(signal ? { signal } : {}),
    };
    return client.callTool(
      { name: toolName, arguments: params },
      undefined,
      options,
    );
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

  private async _withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP ${operation} timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private _createTransport(config: McpServerConfig) {
    switch (config.transport) {
      case 'stdio': {
        const env = { ...process.env } as Record<string, string>;
        if (config.env) Object.assign(env, config.env);
        return new StdioClientTransport({
          command: config.command!,
          ...(config.args ? { args: config.args } : {}),
          env,
        });
      }
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

  /** Auto-reconnect after unexpected disconnection with jitter and max retry limit. */
  private async _reconnect(serverName: string): Promise<void> {
    const entry = this._servers.get(serverName);
    if (!entry) return;

    const maxAttempts = this._options.maxReconnectAttempts;
    const baseDelay = this._options.reconnectDelayMs;
    const currentAttempt = this._reconnectAttempts.get(serverName) ?? 0;

    for (let attempt = currentAttempt + 1; attempt <= maxAttempts; attempt++) {
      this._reconnectAttempts.set(serverName, attempt);
      debugLog(`[McpManager] Reconnecting '${serverName}' attempt ${attempt}/${maxAttempts}`);

      try {
        // Remove stale error-state entry so connectServer can create a fresh one on each attempt
        this._servers.delete(serverName);
        await this.connectServer(entry.config);
        this._reconnectAttempts.delete(serverName);
        debugLog(`[McpManager] '${serverName}' reconnected successfully`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[McpManager] '${serverName}' reconnect attempt ${attempt} failed: ${msg}`);

        if (attempt < maxAttempts) {
          // Exponential backoff with ±25% jitter
          const base = baseDelay * Math.pow(2, attempt - 1);
          const jitter = base * (0.75 + Math.random() * 0.5);
          await new Promise(resolve => setTimeout(resolve, jitter));
        }
      }
    }

    // All attempts exhausted
    this._reconnectAttempts.delete(serverName);
    this._servers.set(serverName, {
      config: entry.config,
      client: null,
      transport: null,
      state: {
        status: 'exhausted',
        message: `Reconnect failed after ${maxAttempts} attempts`,
        since: Date.now(),
      },
    });
    debugLog(`[McpManager] '${serverName}' reconnect exhausted after ${maxAttempts} attempts`);
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
