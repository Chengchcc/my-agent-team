# MCP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP Client support so the agent can connect to external MCP servers and consume their tools, resources, and prompts.

**Architecture:** `McpManager` manages all server connections via `@modelcontextprotocol/sdk`. `McpToolAdapter` wraps MCP tools as `ToolImplementation` and registers them in the existing `ToolRegistry`. Resources are injected via a `beforeModel` hook. Prompts are exposed as additional tools. A `mcp_status` event type surfaces connection changes to CLI/TUI consumers.

**Tech Stack:** TypeScript, Bun, `@modelcontextprotocol/sdk`

---

## File Structure

```
src/mcp/                         (all new)
  ├── index.ts                   public re-exports + singleton accessor
  ├── types.ts                   McpConnectionState, McpCapabilities, McpToolDef, etc.
  ├── manager.ts                 McpManager — connection lifecycle + capability aggregation
  ├── tool-adapter.ts            McpToolAdapter implements ToolImplementation
  ├── resource-middleware.ts     createMcpResourceMiddleware — beforeModel hook
  ├── prompt-registry.ts         McpPromptRegistry — expose prompts as tools
  └── tools.ts                   McpAddServerTool, McpRemoveServerTool, McpListServersTool

src/config/types.ts              + McpServerConfig, McpSettings (modify)
src/config/defaults.ts           + mcp default values (modify)
src/config/constants.ts          + MCP default constants (modify)
src/runtime.ts                   + MCP integration in createAgentRuntime() (modify)
src/agent/loop-types.ts          + McpStatusEvent (modify)

src/cli/tui/types.ts             + mcpManager in CommandHandlerContext (modify)
src/cli/tui/commands/mcp-commands.ts  (new)
src/cli/tui/command-registry.ts  + MCP commands in getBuiltinCommands (modify)

bin/my-agent.ts                  + --no-mcp, --mcp-server, --mcp-server-file, --mcp-debug, mcp subcommand dispatch (modify)
bin/mcp-cli.ts                   (new)
```

---

### Task 1: Install dependency and add config types

**Files:**
- Modify: `src/config/constants.ts`
- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`

- [ ] **Step 1: Add MCP constants**

In `src/config/constants.ts`, append:

```typescript
// --- MCP defaults ---
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_RECONNECT_ATTEMPTS = 3;
export const DEFAULT_MCP_RECONNECT_DELAY_MS = 1_000;
```

- [ ] **Step 2: Add config types**

In `src/config/types.ts`, after `SecuritySettings` (before `DebugSettings`), add:

```typescript
export interface McpServerConfig {
  /** Unique server name, used for tool prefix generation */
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  /** stdio transport */
  command?: string;
  args?: string[];
  /** SSE / Streamable HTTP transport */
  url?: string;
  headers?: Record<string, string>;
  /** Environment variables injected to child process */
  env?: Record<string, string>;
  /** Automatically connect at agent startup (default: true) */
  autoStart?: boolean;
}

export interface McpSettings {
  enabled: boolean;
  servers: McpServerConfig[];
  /** Per-tool call timeout in ms */
  toolTimeoutMs: number;
  /** Max reconnection attempts on failure */
  reconnectAttempts: number;
  /** Base delay between reconnection attempts in ms */
  reconnectDelayMs: number;
}
```

In `Settings` interface, add after `debug`:

```typescript
mcp: McpSettings;
```

- [ ] **Step 3: Add MCP defaults**

In `src/config/defaults.ts`, add imports:

```typescript
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_MAX_SUMMARY_TOKENS,
  DEFAULT_TOKEN_LIMIT,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  DEFAULT_MCP_RECONNECT_ATTEMPTS,
  DEFAULT_MCP_RECONNECT_DELAY_MS,
} from './constants';
```

In `defaultSettings` object, add after `subAgent`:

```typescript
mcp: {
  enabled: false,
  servers: [],
  toolTimeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS,
  reconnectAttempts: DEFAULT_MCP_RECONNECT_ATTEMPTS,
  reconnectDelayMs: DEFAULT_MCP_RECONNECT_DELAY_MS,
},
```

- [ ] **Step 4: Install @modelcontextprotocol/sdk**

Run: `bun add @modelcontextprotocol/sdk`

Expected: dependency added to package.json and bun.lock.

- [ ] **Step 5: Verify compilation**

Run: `bun run tsc`

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/config/constants.ts src/config/types.ts src/config/defaults.ts package.json bun.lock
git commit -m "feat: add MCP config types, defaults, and @modelcontextprotocol/sdk dependency"
```

---

### Task 2: Create MCP runtime types

**Files:**
- Create: `src/mcp/types.ts`
- Create: `src/mcp/index.ts`

- [ ] **Step 1: Write src/mcp/types.ts**

```typescript
import type { McpServerConfig } from '../config/types';

export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpToolDef {
  name: string;
  description?: string;
  /** JSON Schema for tool input */
  parameters: Record<string, unknown>;
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptResult {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface McpCapabilities {
  tools: McpToolDef[];
  resources: McpResourceDef[];
  prompts: McpPromptDef[];
}

export type McpConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; capabilities: McpCapabilities; startedAt: number }
  | { status: 'error'; message: string; since: number };

/** Internal per-server entry held by McpManager */
export interface McpClientEntry {
  config: McpServerConfig;
  client: unknown;    // @modelcontextprotocol/sdk Client — cast at usage site
  transport: unknown; // Transport instance — cast at usage site
  state: McpConnectionState;
}
```

- [ ] **Step 2: Write src/mcp/index.ts**

```typescript
export type {
  McpConnectionState,
  McpConnectionStatus,
  McpToolDef,
  McpResourceDef,
  McpPromptDef,
  McpPromptArgument,
  McpPromptResult,
  McpCapabilities,
  McpClientEntry,
} from './types';

export { McpManager } from './manager';
export { McpToolAdapter, formatToolName, TOOL_PREFIX } from './tool-adapter';
export { createMcpResourceMiddleware } from './resource-middleware';
export { McpPromptRegistry, formatPromptName } from './prompt-registry';
export { McpListServersTool, McpAddServerTool, McpRemoveServerTool } from './tools';
```

- [ ] **Step 3: Verify compilation**

Run: `bun run tsc`

Expected: errors about missing imports (manager, tool-adapter, etc.) — expected since we haven't written them yet. Confirm the types.ts file itself has no errors.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/types.ts src/mcp/index.ts
git commit -m "feat: add MCP runtime types"
```

---

### Task 3: Implement McpManager

**Files:**
- Create: `src/mcp/manager.ts`

- [ ] **Step 1: Write src/mcp/manager.ts**

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '../config/types';
import type {
  McpConnectionState,
  McpCapabilities,
  McpToolDef,
  McpResourceDef,
  McpPromptDef,
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

      await client.connect(transport);

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
        await (entry.client as Client).close();
      }
    } catch (err) {
      debugLog(`[McpManager] Error closing '${name}': ${err}`);
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
    const entry = this._servers.get(serverName);
    if (!entry || entry.state.status !== 'connected') {
      throw new Error(`MCP server '${serverName}' is not connected`);
    }
    const client = entry.client as Client;
    return client.callTool({ name: toolName, arguments: params });
  }

  async readResource(serverName: string, uri: string): Promise<unknown> {
    const entry = this._servers.get(serverName);
    if (!entry || entry.state.status !== 'connected') {
      throw new Error(`MCP server '${serverName}' is not connected`);
    }
    const client = entry.client as Client;
    return client.readResource({ uri });
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    args: Record<string, string>,
  ): Promise<McpPromptResult> {
    const entry = this._servers.get(serverName);
    if (!entry || entry.state.status !== 'connected') {
      throw new Error(`MCP server '${serverName}' is not connected`);
    }
    const client = entry.client as Client;
    const result = await client.getPrompt({ name: promptName, arguments: args });
    return result as McpPromptResult;
  }

  private _createTransport(config: McpServerConfig) {
    switch (config.transport) {
      case 'stdio':
        return new StdioClientTransport({
          command: config.command!,
          args: config.args,
          env: config.env,
        });
      case 'sse':
        return new SSEClientTransport(
          new URL(config.url!),
          { requestInit: config.headers ? { headers: config.headers } : undefined },
        );
      case 'streamable-http':
        return new StreamableHTTPClientTransport(
          new URL(config.url!),
          { requestInit: config.headers ? { headers: config.headers } : undefined },
        );
      default:
        throw new Error(`Unknown transport: ${(config as McpServerConfig).transport}`);
    }
  }

  private async _listTools(client: Client): Promise<McpToolDef[]> {
    const result = await client.listTools();
    return (result.tools || []).map((t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  private async _listResources(client: Client): Promise<McpResourceDef[]> {
    try {
      const result = await client.listResources();
      return (result.resources || []).map((r: { uri: string; name: string; description?: string; mimeType?: string }) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    } catch {
      return [];
    }
  }

  private async _listPrompts(client: Client): Promise<McpPromptDef[]> {
    try {
      const result = await client.listPrompts();
      return (result.prompts || []).map((p: { name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      }));
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 2: Write unit test**

Create `tests/mcp/manager.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { McpManager } from '../../src/mcp/manager';

const defaultOptions = {
  toolTimeoutMs: 5000,
  reconnectAttempts: 1,
  reconnectDelayMs: 100,
};

describe('McpManager', () => {
  it('starts with no servers without error', async () => {
    const manager = new McpManager(defaultOptions);
    await manager.start([]);
    expect(manager.getConnectionStates().size).toBe(0);
    await manager.shutdown();
  });

  it('hasServer returns false for unknown server', () => {
    const manager = new McpManager(defaultOptions);
    expect(manager.hasServer('nonexistent')).toBe(false);
  });

  it('getAllTools returns empty when no servers connected', () => {
    const manager = new McpManager(defaultOptions);
    expect(manager.getAllTools()).toEqual([]);
  });

  it('getAllResources returns empty when no servers connected', () => {
    const manager = new McpManager(defaultOptions);
    expect(manager.getAllResources()).toEqual([]);
  });

  it('getAllPrompts returns empty when no servers connected', () => {
    const manager = new McpManager(defaultOptions);
    expect(manager.getAllPrompts()).toEqual([]);
  });

  it('removeServer is no-op for unknown server', async () => {
    const manager = new McpManager(defaultOptions);
    await manager.removeServer('nonexistent');
    // no throw = pass
  });

  it('getConnectionStates is empty initially', () => {
    const manager = new McpManager(defaultOptions);
    expect(manager.getConnectionStates().size).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/mcp/manager.test.ts`

- [ ] **Step 4: Verify compilation**

Run: `bun run tsc`

- [ ] **Step 5: Commit**

```bash
git add src/mcp/manager.ts tests/mcp/manager.test.ts
git commit -m "feat: implement McpManager connection lifecycle"
```

---

### Task 4: Implement McpToolAdapter

**Files:**
- Create: `src/mcp/tool-adapter.ts`

- [ ] **Step 1: Write src/mcp/tool-adapter.ts**

```typescript
import type { Tool, ToolImplementation } from '../types';
import type { ToolContext } from '../agent/tool-dispatch/types';
import type { McpManager } from './manager';
import type { McpToolDef } from './types';

export const TOOL_PREFIX = 'mcp__';

const READONLY_PREFIXES = ['list_', 'read_', 'search_', 'get_', 'find_'];

function isReadonly(toolDef: McpToolDef): boolean {
  return READONLY_PREFIXES.some(prefix => toolDef.name.startsWith(prefix));
}

export function formatToolName(serverName: string, toolName: string): string {
  return `${TOOL_PREFIX}${serverName}__${toolName}`;
}

export class McpToolAdapter implements ToolImplementation {
  readonly readonly: boolean;
  readonly conflictKey?: (input: unknown) => string | null;

  constructor(
    private manager: McpManager,
    private serverName: string,
    private toolDef: McpToolDef,
  ) {
    if (isReadonly(toolDef)) {
      this.readonly = true;
      this.conflictKey = () => null;
    }
  }

  getDefinition(): Tool {
    return {
      name: formatToolName(this.serverName, this.toolDef.name),
      description: this.toolDef.description ??
        `MCP tool '${this.toolDef.name}' from server '${this.serverName}'`,
      parameters: this.toolDef.parameters,
    };
  }

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const result = await this.manager.executeTool(
      this.serverName,
      this.toolDef.name,
      params,
    );
    return this._unwrapContent(result);
  }

  private _unwrapContent(result: unknown): string {
    const callResult = result as {
      content?: Array<{ type: string; text?: string; mimeType?: string; resource?: unknown }>;
      isError?: boolean;
    };

    if (!callResult.content || callResult.content.length === 0) {
      if (callResult.isError) {
        throw new Error('MCP tool returned error with no content');
      }
      return '';
    }

    const texts: string[] = [];
    for (const block of callResult.content) {
      if (block.type === 'text' && block.text !== undefined) {
        texts.push(block.text);
      } else if (block.type === 'image') {
        texts.push(`[image: ${block.mimeType || 'unknown'}]`);
      } else if (block.type === 'resource') {
        texts.push(JSON.stringify(block.resource));
      }
    }

    const output = texts.join('\n');
    if (callResult.isError) {
      throw new Error(output || 'MCP tool returned error');
    }
    return output;
  }
}
```

- [ ] **Step 2: Write unit test**

Create `tests/mcp/tool-adapter.test.ts`:

```typescript
import { describe, it, expect, mock } from 'bun:test';
import { McpToolAdapter, formatToolName } from '../../src/mcp/tool-adapter';
import type { McpManager } from '../../src/mcp/manager';

function mockManager(executeResult: unknown): McpManager {
  return {
    executeTool: mock(() => Promise.resolve(executeResult)),
  } as unknown as McpManager;
}

describe('formatToolName', () => {
  it('generates correct MCP tool name', () => {
    expect(formatToolName('github', 'search_code')).toBe('mcp__github__search_code');
  });
});

describe('McpToolAdapter', () => {
  it('generates correct tool definition', () => {
    const adapter = new McpToolAdapter(
      mockManager(''),
      'test-server',
      { name: 'list_items', description: 'List all items', parameters: { type: 'object', properties: {} } },
    );
    const def = adapter.getDefinition();
    expect(def.name).toBe('mcp__test-server__list_items');
    expect(def.description).toBe('List all items');
  });

  it('falls back to generated description when none provided', () => {
    const adapter = new McpToolAdapter(
      mockManager(''),
      'srv',
      { name: 'do_thing', parameters: {} },
    );
    const def = adapter.getDefinition();
    expect(def.description).toContain('MCP tool');
    expect(def.description).toContain('srv');
  });

  it('marks list_* tools as readonly', () => {
    const adapter = new McpToolAdapter(mockManager(''), 'srv', { name: 'list_users', parameters: {} });
    expect(adapter.readonly).toBe(true);
  });

  it('marks read_* tools as readonly', () => {
    const adapter = new McpToolAdapter(mockManager(''), 'srv', { name: 'read_file', parameters: {} });
    expect(adapter.readonly).toBe(true);
  });

  it('does not mark write_* tools as readonly', () => {
    const adapter = new McpToolAdapter(mockManager(''), 'srv', { name: 'write_file', parameters: {} });
    expect(adapter.readonly).toBeUndefined();
  });

  it('unwraps text content from execute result', async () => {
    const manager = mockManager({
      content: [{ type: 'text', text: 'hello world' }],
    });
    const adapter = new McpToolAdapter(manager, 'srv', { name: 'test', parameters: {} });
    const result = await adapter.execute({}, {} as never);
    expect(result).toBe('hello world');
  });

  it('throws on error result', async () => {
    const manager = mockManager({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    });
    const adapter = new McpToolAdapter(manager, 'srv', { name: 'test', parameters: {} });
    await expect(adapter.execute({}, {} as never)).rejects.toThrow('something went wrong');
  });

  it('returns empty string for empty content', async () => {
    const manager = mockManager({ content: [] });
    const adapter = new McpToolAdapter(manager, 'srv', { name: 'test', parameters: {} });
    const result = await adapter.execute({}, {} as never);
    expect(result).toBe('');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/mcp/tool-adapter.test.ts`

- [ ] **Step 4: Verify compilation**

Run: `bun run tsc`

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tool-adapter.ts tests/mcp/tool-adapter.test.ts
git commit -m "feat: implement McpToolAdapter for wrapping MCP tools"
```

---

### Task 5: Implement resource middleware

**Files:**
- Create: `src/mcp/resource-middleware.ts`

- [ ] **Step 1: Write src/mcp/resource-middleware.ts**

```typescript
import type { AgentContext, AgentMiddleware } from '../types';
import type { McpManager } from './manager';
import type { McpResourceDef } from './types';

const MAX_RESOURCES_INJECTED = 50;

export function createMcpResourceMiddleware(manager: McpManager): AgentMiddleware {
  let lastResourceKeys: string | null = null;

  return {
    beforeModel: async (ctx: AgentContext, next: () => Promise<AgentContext>) => {
      const resources = manager.getAllResources();
      if (resources.length === 0) return next();

      const currentKeys = resources
        .map(r => r.resource.uri)
        .sort()
        .join(',');
      if (currentKeys === lastResourceKeys) return next();
      lastResourceKeys = currentKeys;

      const injected = resources.slice(0, MAX_RESOURCES_INJECTED);
      let catalog = injected.map(r =>
        `- ${r.serverName}: ${r.resource.uri}${r.resource.mimeType ? ` (${r.resource.mimeType})` : ''}${r.resource.description ? ` — ${r.resource.description}` : ''}`,
      ).join('\n');

      if (resources.length > MAX_RESOURCES_INJECTED) {
        catalog += `\n... and ${resources.length - MAX_RESOURCES_INJECTED} more resources`;
      }

      ctx.ephemeralReminders ??= [];
      ctx.ephemeralReminders.push(`[MCP Resources Available]\n${catalog}`);
      return next();
    },
  };
}
```

- [ ] **Step 2: Write unit test**

Create `tests/mcp/resource-middleware.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { createMcpResourceMiddleware } from '../../src/mcp/resource-middleware';
import type { McpManager } from '../../src/mcp/manager';
import type { AgentContext } from '../../src/types';

function mockManager(resources: Array<{ serverName: string; resource: { uri: string; name: string; description?: string; mimeType?: string } }>): McpManager {
  return {
    getAllResources: () => resources,
  } as unknown as McpManager;
}

describe('createMcpResourceMiddleware', () => {
  it('injects resource catalog into ephemeralReminders', async () => {
    const manager = mockManager([
      { serverName: 'test', resource: { uri: 'file:///data', name: 'data', description: 'Test data', mimeType: 'text/plain' } },
    ]);
    const middleware = createMcpResourceMiddleware(manager);
    const ctx: AgentContext = {
      messages: [],
      config: { tokenLimit: 100000 },
      metadata: {},
    };

    const next = async () => ctx;
    if (middleware.beforeModel) {
      await middleware.beforeModel(ctx, next);
    }

    expect(ctx.ephemeralReminders).toBeDefined();
    expect(ctx.ephemeralReminders![0]).toContain('file:///data');
    expect(ctx.ephemeralReminders![0]).toContain('Test data');
  });

  it('skips when no resources', async () => {
    const manager = mockManager([]);
    const middleware = createMcpResourceMiddleware(manager);
    const ctx: AgentContext = { messages: [], config: { tokenLimit: 100000 }, metadata: {} };
    const next = async () => ctx;
    if (middleware.beforeModel) {
      await middleware.beforeModel(ctx, next);
    }
    expect(ctx.ephemeralReminders).toBeUndefined();
  });

  it('skips on same resource set to avoid duplicate injection', async () => {
    const manager = mockManager([
      { serverName: 'a', resource: { uri: 'u1', name: 'n1' } },
    ]);
    const middleware = createMcpResourceMiddleware(manager);
    const ctx: AgentContext = { messages: [], config: { tokenLimit: 100000 }, metadata: {} };
    const next = async () => ctx;
    if (middleware.beforeModel) {
      await middleware.beforeModel(ctx, next);
    }
    expect(ctx.ephemeralReminders).toHaveLength(1);

    // Second call with same resources should not add another reminder
    if (middleware.beforeModel) {
      await middleware.beforeModel(ctx, next);
    }
    expect(ctx.ephemeralReminders).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/mcp/resource-middleware.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/mcp/resource-middleware.ts tests/mcp/resource-middleware.test.ts
git commit -m "feat: implement MCP resource middleware for context injection"
```

---

### Task 6: Implement McpPromptRegistry

**Files:**
- Create: `src/mcp/prompt-registry.ts`

- [ ] **Step 1: Write src/mcp/prompt-registry.ts**

```typescript
import type { Tool, ToolImplementation } from '../types';
import type { ToolContext } from '../agent/tool-dispatch/types';
import type { McpManager } from './manager';
import type { McpPromptDef } from './types';
import type { ToolRegistry } from '../agent/tool-registry';
import { formatToolName } from './tool-adapter';

export function formatPromptName(serverName: string, promptName: string): string {
  return formatToolName(serverName, `prompt__${promptName}`);
}

class McpPromptTool implements ToolImplementation {
  constructor(
    private manager: McpManager,
    private serverName: string,
    private promptDef: McpPromptDef,
  ) {}

  getDefinition(): Tool {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const arg of this.promptDef.arguments || []) {
      properties[arg.name] = { type: 'string', description: arg.description || arg.name };
      if (arg.required) required.push(arg.name);
    }

    return {
      name: formatPromptName(this.serverName, this.promptDef.name),
      description: this.promptDef.description ??
        `MCP prompt '${this.promptDef.name}' from server '${this.serverName}'`,
      parameters: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    };
  }

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const stringArgs: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      stringArgs[key] = String(value);
    }

    const result = await this.manager.getPrompt(
      this.serverName,
      this.promptDef.name,
      stringArgs,
    );

    return result.messages
      .map(m => `[${m.role}]\n${m.content}`)
      .join('\n\n');
  }
}

export class McpPromptRegistry {
  constructor(private manager: McpManager) {}

  getAll(): Array<{ serverName: string; prompt: McpPromptDef }> {
    return this.manager.getAllPrompts();
  }

  registerAsTool(
    serverName: string,
    promptDef: McpPromptDef,
    toolRegistry: ToolRegistry,
  ): void {
    const tool = new McpPromptTool(this.manager, serverName, promptDef);
    toolRegistry.register(tool);
  }
}
```

- [ ] **Step 2: Write unit test**

Create `tests/mcp/prompt-registry.test.ts`:

```typescript
import { describe, it, expect, mock } from 'bun:test';
import { McpPromptRegistry, formatPromptName } from '../../src/mcp/prompt-registry';
import type { McpManager } from '../../src/mcp/manager';
import { ToolRegistry } from '../../src/agent/tool-registry';

function mockManager(): McpManager {
  return {
    getAllPrompts: () => [
      {
        serverName: 'test',
        prompt: {
          name: 'greeting',
          description: 'Generate a greeting',
          arguments: [{ name: 'name', description: 'User name', required: true }],
        },
      },
    ],
    getPrompt: mock(async () => ({
      messages: [{ role: 'user' as const, content: 'Hello there' }],
    })),
  } as unknown as McpManager;
}

describe('formatPromptName', () => {
  it('generates correct prompt tool name', () => {
    expect(formatPromptName('github', 'greeting')).toBe('mcp__github__prompt__greeting');
  });
});

describe('McpPromptRegistry', () => {
  it('registers prompt as tool in ToolRegistry', () => {
    const manager = mockManager();
    const registry = new McpPromptRegistry(manager);
    const toolRegistry = new ToolRegistry();

    const all = registry.getAll();
    expect(all.length).toBe(1);
    registry.registerAsTool(all[0]!.serverName, all[0]!.prompt, toolRegistry);

    const tool = toolRegistry.get('mcp__test__prompt__greeting');
    expect(tool).toBeDefined();
    const def = tool!.getDefinition();
    expect(def.parameters.required).toEqual(['name']);
  });

  it('executes prompt via manager.getPrompt', async () => {
    const manager = mockManager();
    const registry = new McpPromptRegistry(manager);
    const toolRegistry = new ToolRegistry();

    registry.registerAsTool('test', {
      name: 'greeting',
      arguments: [{ name: 'name', required: true }],
    }, toolRegistry);

    const tool = toolRegistry.get('mcp__test__prompt__greeting');
    const result = await tool!.execute({ name: 'Alice' }, {} as never);
    expect(result).toContain('Hello there');
    expect(result).toContain('[user]');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/mcp/prompt-registry.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/mcp/prompt-registry.ts tests/mcp/prompt-registry.test.ts
git commit -m "feat: implement McpPromptRegistry for MCP prompt tool exposure"
```

---

### Task 7: Implement MCP management tools

**Files:**
- Create: `src/mcp/tools.ts`

- [ ] **Step 1: Write src/mcp/tools.ts**

```typescript
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
      const icon = state.status === 'connected' ? '\u2713'
        : state.status === 'error' ? '\u2717'
        : state.status === 'connecting' ? '\u2026'
        : '\u25CB';
      const detail = state.status === 'connected'
        ? `${state.capabilities.tools.length} tools, ${state.capabilities.resources.length} resources, ${state.capabilities.prompts.length} prompts`
        : state.status === 'error' ? state.message : '';
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
      description: 'Connect to a new MCP server and register its tools and prompts. Session-only (not persisted to settings).',
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
```

- [ ] **Step 2: Write unit test**

Create `tests/mcp/tools.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { McpListServersTool } from '../../src/mcp/tools';
import type { McpManager } from '../../src/mcp/manager';

function mockManagerWithStates(states: Map<string, unknown>): McpManager {
  return {
    getConnectionStates: () => states,
  } as unknown as McpManager;
}

describe('McpListServersTool', () => {
  it('returns message when no servers', async () => {
    const manager = mockManagerWithStates(new Map());
    const tool = new McpListServersTool(manager);
    const result = await tool.execute({}, {} as never);
    expect(result).toBe('No MCP servers configured.');
  });

  it('lists connected server with tool count', async () => {
    const states = new Map();
    states.set('test', {
      status: 'connected',
      capabilities: { tools: [{ name: 't1', parameters: {} }], resources: [], prompts: [] },
      startedAt: Date.now(),
    });
    const manager = mockManagerWithStates(states);
    const tool = new McpListServersTool(manager);
    const result = await tool.execute({}, {} as never);
    expect(result).toContain('test');
    expect(result).toContain('connected');
    expect(result).toContain('1 tools');
  });

  it('shows error status with message', async () => {
    const states = new Map();
    states.set('bad', {
      status: 'error',
      message: 'Connection refused',
      since: Date.now(),
    });
    const manager = mockManagerWithStates(states);
    const tool = new McpListServersTool(manager);
    const result = await tool.execute({}, {} as never);
    expect(result).toContain('bad');
    expect(result).toContain('error');
    expect(result).toContain('Connection refused');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/mcp/tools.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/tools.test.ts
git commit -m "feat: implement MCP management tools (add/remove/list servers)"
```

---

### Task 8: Add mcp_status event type

**Files:**
- Modify: `src/agent/loop-types.ts`

- [ ] **Step 1: Add McpStatusEvent interface**

After `ContextCompactedEvent` (line ~156), add:

```typescript
/**
 * MCP server connection status change.
 */
export interface McpStatusEvent extends AgentEventBase {
  type: 'mcp_status';
  serverName: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  error?: string;
  toolCount?: number;
}
```

- [ ] **Step 2: Add to AgentEvent union**

Add `| McpStatusEvent` before the final `;` in the `AgentEvent` union type.

- [ ] **Step 3: Verify compilation**

Run: `bun run tsc`

- [ ] **Step 4: Commit**

```bash
git add src/agent/loop-types.ts
git commit -m "feat: add McpStatusEvent to agent event types"
```

---

### Task 9: Integrate MCP into createAgentRuntime

**Files:**
- Modify: `src/runtime.ts`

- [ ] **Step 1: Update imports**

Add with other imports:

```typescript
import { McpManager } from './mcp/manager';
import { McpToolAdapter } from './mcp/tool-adapter';
import { createMcpResourceMiddleware } from './mcp/resource-middleware';
import { McpPromptRegistry } from './mcp/prompt-registry';
import { McpListServersTool, McpAddServerTool, McpRemoveServerTool } from './mcp/tools';
import { DEFAULT_MCP_TOOL_TIMEOUT_MS, DEFAULT_MCP_RECONNECT_ATTEMPTS, DEFAULT_MCP_RECONNECT_DELAY_MS } from './config/constants';
```

- [ ] **Step 2: Extend RuntimeConfig**

Add to `RuntimeConfig` interface:

```typescript
  /** Disable MCP client (default: false, enabled if settings.mcp.enabled is true) */
  enableMcp?: boolean;
  /** Additional MCP servers from CLI (merged with settings, CLI overrides by name) */
  mcpServers?: import('./config/types').McpServerConfig[];
```

- [ ] **Step 3: Extend AgentRuntime**

Add to `AgentRuntime` interface:

```typescript
  mcpManager?: McpManager;
```

- [ ] **Step 4: Add MCP assembly logic**

Add destructure `enableMcp` from config:

```typescript
const {
  // ... existing destructured fields
  enableMcp,
} = config;
```

After the SubAgentTool registration block (and before memory), add:

```typescript
  // MCP Client
  let mcpManager: McpManager | undefined;
  let mcpPromptRegistry: McpPromptRegistry | undefined;
  if (enableMcp !== false) {
    const mcpSettings = settings?.mcp ?? {
      enabled: false,
      servers: [],
      toolTimeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS,
      reconnectAttempts: DEFAULT_MCP_RECONNECT_ATTEMPTS,
      reconnectDelayMs: DEFAULT_MCP_RECONNECT_DELAY_MS,
    };
    const cliServers = config.mcpServers ?? [];

    // Merge: CLI servers override settings servers by name
    const mergedServers = [...mcpSettings.servers];
    for (const cliServer of cliServers) {
      const idx = mergedServers.findIndex(s => s.name === cliServer.name);
      if (idx >= 0) {
        mergedServers[idx] = cliServer;
      } else {
        mergedServers.push(cliServer);
      }
    }

    if (mcpSettings.enabled || mergedServers.length > 0) {
      mcpManager = new McpManager({
        toolTimeoutMs: mcpSettings.toolTimeoutMs,
        reconnectAttempts: mcpSettings.reconnectAttempts,
        reconnectDelayMs: mcpSettings.reconnectDelayMs,
      });

      mcpPromptRegistry = new McpPromptRegistry(mcpManager);

      try {
        await mcpManager.start(mergedServers);

        for (const { serverName, tool: toolDef } of mcpManager.getAllTools()) {
          toolRegistry.register(new McpToolAdapter(mcpManager, serverName, toolDef));
        }

        for (const { serverName, prompt: promptDef } of mcpManager.getAllPrompts()) {
          mcpPromptRegistry.registerAsTool(serverName, promptDef, toolRegistry);
        }

        const resourceMiddleware = createMcpResourceMiddleware(mcpManager);
        if (resourceMiddleware.beforeModel) {
          hooks.beforeModel.push(resourceMiddleware.beforeModel);
        }

        toolRegistry.register(new McpListServersTool(mcpManager));
        toolRegistry.register(new McpAddServerTool(mcpManager, toolRegistry, mcpPromptRegistry));
        toolRegistry.register(new McpRemoveServerTool(mcpManager, toolRegistry));

        hooks.afterAgentRun.push(async () => {
          await mcpManager!.shutdown();
        });

        debugLog('MCP initialized');
      } catch (err) {
        debugLog(`MCP initialization failed: ${err}`);
      }
    }
  }
```

- [ ] **Step 5: Include mcpManager in runtime return**

In the `runtime` object literal, add:

```typescript
  if (mcpManager) runtime.mcpManager = mcpManager;
```

- [ ] **Step 6: Verify compilation**

Run: `bun run tsc`

- [ ] **Step 7: Commit**

```bash
git add src/runtime.ts
git commit -m "feat: integrate MCP into createAgentRuntime assembly"
```

---

### Task 10: Wire MCP into headless CLI

**Files:**
- Modify: `bin/my-agent.ts`

- [ ] **Step 1: Add parseArgs options**

In the `options` object of `parseArgs`, add:

```typescript
    'no-mcp':       { type: 'boolean', default: false },
    'mcp-server':   { type: 'string', multiple: true },
    'mcp-server-file': { type: 'string' },
    'mcp-debug':    { type: 'boolean', default: false },
```

- [ ] **Step 2: Add mcp subcommand dispatch**

After the version check block and before `setDebugMode(...)`, add:

```typescript
// MCP subcommand mode — manage server config, no agent loop
if (positionals[0] === 'mcp') {
  const { runMcpCli } = await import('./mcp-cli');
  await runMcpCli(positionals.slice(1), values);
  process.exit(0);
}
```

- [ ] **Step 3: Wire RuntimeConfig**

In the `runtimeConfig` construction, add:

```typescript
    enableMcp: !values['no-mcp'],
```

After the `runtimeConfig` block (before `const runtime = await createAgentRuntime(runtimeConfig)`), add:

```typescript
  // Parse --mcp-server (repeatable, inline JSON)
  const mcpServers = (Array.isArray(values['mcp-server']) ? values['mcp-server'] as string[] : []).map(s => JSON.parse(s));

  // Parse --mcp-server-file
  if (values['mcp-server-file']) {
    const fileContent = await Bun.file(String(values['mcp-server-file'])).text();
    const parsed = JSON.parse(fileContent) as unknown;
    for (const s of (Array.isArray(parsed) ? parsed : [parsed])) {
      mcpServers.push(s as McpServerConfig);
    }
  }

  if (mcpServers.length > 0) {
    runtimeConfig.mcpServers = mcpServers;
  }
```

Add import at top:

```typescript
import type { McpServerConfig } from '../src/config/types';
```

- [ ] **Step 4: Handle mcp_status in writeTextEvent**

Add case in the switch:

```typescript
    case 'mcp_status':
      if (values['mcp-debug']) {
        const icon = event.status === 'connected' ? '+'
          : event.status === 'error' ? '!'
          : '-';
        const detail = event.status === 'connected' && event.toolCount
          ? ` (${event.toolCount} tools)`
          : event.error ? ` — ${event.error}` : '';
        process.stderr.write(`[mcp:${event.serverName}] ${icon} ${event.status}${detail}\n`);
      }
      break;
```

- [ ] **Step 5: Handle mcp_status in writeStreamJsonEvent**

Add case:

```typescript
    case 'mcp_status':
      serializable.server = event.serverName;
      serializable.serverStatus = event.status;
      if (event.error) serializable.error = event.error;
      if (event.toolCount !== undefined) serializable.toolCount = event.toolCount;
      break;
```

- [ ] **Step 6: Update help text**

Add to the help usage string:

```
  --no-mcp                   Disable MCP client
  --mcp-server '<json>'      Add an MCP server (repeatable, inline JSON)
  --mcp-server-file <path>   Add MCP servers from a JSON file
  --mcp-debug                Show MCP connection details in stderr
```

- [ ] **Step 7: Verify compilation**

Run: `bun run tsc`

- [ ] **Step 8: Commit**

```bash
git add bin/my-agent.ts
git commit -m "feat: add MCP CLI flags, mcp subcommand, and event handling to headless CLI"
```

---

### Task 11: Implement MCP CLI management

**Files:**
- Create: `bin/mcp-cli.ts`

- [ ] **Step 1: Write bin/mcp-cli.ts**

```typescript
#!/usr/bin/env bun
import { getSettings } from '../src/config';
import type { McpServerConfig } from '../src/config/types';

const settingsPath = process.env.MY_AGENT_SETTINGS_PATH ||
  `${process.env.HOME || '/root'}/.my-agent/settings.json`;

async function readSettings(): Promise<Record<string, unknown>> {
  const file = Bun.file(settingsPath);
  if (await file.exists()) {
    return file.json() as Promise<Record<string, unknown>>;
  }
  return {};
}

async function writeSettings(data: Record<string, unknown>): Promise<void> {
  await Bun.write(settingsPath, JSON.stringify(data, null, 2) + '\n');
}

async function cmdList(): Promise<void> {
  await getSettings();
  const raw = await readSettings();
  const settings = raw as { mcp?: { servers?: McpServerConfig[] } };
  const servers = settings.mcp?.servers ?? [];

  if (servers.length === 0) {
    console.log('No MCP servers configured.');
    return;
  }

  for (const s of servers) {
    const details = s.transport === 'stdio'
      ? `${s.command} ${(s.args || []).join(' ')}`
      : s.url || '';
    console.log(`${s.name} [${s.transport}]${s.autoStart === false ? ' (manual start)' : ''}`);
    console.log(`  ${details}`);
    if (s.env && Object.keys(s.env).length > 0) {
      console.log(`  env: ${Object.keys(s.env).join(', ')}`);
    }
  }
}

async function cmdAdd(name: string, values: Record<string, unknown>): Promise<void> {
  const transport = String(values.transport || 'stdio');
  const server: McpServerConfig = {
    name,
    transport: transport as McpServerConfig['transport'],
    autoStart: !values['no-auto-start'],
  };

  if (transport === 'stdio') {
    if (!values.command) {
      console.error('Error: --command is required for stdio transport');
      process.exit(1);
    }
    server.command = String(values.command);
    if (values.args) server.args = values.args as string[];
  } else {
    if (!values.url) {
      console.error('Error: --url is required for sse/streamable-http transport');
      process.exit(1);
    }
    server.url = String(values.url);
  }

  if (values.header) {
    const headers: Record<string, string> = {};
    for (const h of (values.header as string[])) {
      const idx = h.indexOf('=');
      if (idx > 0) headers[h.slice(0, idx)] = h.slice(idx + 1);
    }
    if (Object.keys(headers).length > 0) server.headers = headers;
  }

  if (values.env) {
    const env: Record<string, string> = {};
    for (const e of (values.env as string[])) {
      const idx = e.indexOf('=');
      if (idx > 0) env[e.slice(0, idx)] = e.slice(idx + 1);
    }
    if (Object.keys(env).length > 0) server.env = env;
  }

  const raw = await readSettings();
  const data = raw as { mcp?: { enabled?: boolean; servers?: McpServerConfig[] } };
  if (!data.mcp) data.mcp = { enabled: true, servers: [] };
  if (!data.mcp.servers) data.mcp.servers = [];

  const idx = data.mcp.servers.findIndex(s => s.name === name);
  if (idx >= 0) {
    data.mcp.servers[idx] = server;
    console.log(`Updated MCP server '${name}'.`);
  } else {
    data.mcp.servers.push(server);
    console.log(`Added MCP server '${name}'.`);
  }

  await writeSettings(data as Record<string, unknown>);
  console.log('Settings saved. Restart agent to apply changes.');
}

async function cmdRemove(name: string): Promise<void> {
  const raw = await readSettings();
  const data = raw as { mcp?: { servers?: McpServerConfig[] } };
  const servers = data.mcp?.servers ?? [];

  const idx = servers.findIndex(s => s.name === name);
  if (idx < 0) {
    console.error(`Error: MCP server '${name}' not found.`);
    process.exit(1);
  }

  servers.splice(idx, 1);
  await writeSettings(data as Record<string, unknown>);
  console.log(`Removed MCP server '${name}'.`);
}

export async function runMcpCli(args: string[], values: Record<string, unknown>): Promise<void> {
  const cmd = args[0];

  switch (cmd) {
    case 'list':
      await cmdList();
      break;
    case 'status': {
      const name = args[1];
      if (!name) {
        console.error('Usage: my-agent mcp status <server-name>');
        process.exit(1);
      }
      await cmdList();
      break;
    }
    case 'add': {
      const name = args[1];
      if (!name) {
        console.error('Usage: my-agent mcp add <name> --transport <type> [--command <cmd>] [--args <...>] [--url <url>] [--header k=v] [--env k=v] [--no-auto-start]');
        process.exit(1);
      }
      await cmdAdd(name, values);
      break;
    }
    case 'remove': {
      const name = args[1];
      if (!name) {
        console.error('Usage: my-agent mcp remove <name>');
        process.exit(1);
      }
      await cmdRemove(name);
      break;
    }
    default:
      console.log([
        'Usage: my-agent mcp <command>',
        '',
        'Commands:',
        '  list              List configured MCP servers',
        '  status <name>     Show server details',
        '  add <name>        Add and persist a server to settings',
        '  remove <name>     Remove a server from settings',
      ].join('\n'));
      process.exit(1);
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `bun run tsc`

- [ ] **Step 3: Commit**

```bash
git add bin/mcp-cli.ts
git commit -m "feat: implement MCP CLI management (list/add/remove servers)"
```

---

### Task 12: Wire MCP into TUI

**Files:**
- Modify: `src/cli/tui/types.ts`
- Create: `src/cli/tui/commands/mcp-commands.ts`
- Modify: `src/cli/tui/command-registry.ts`
- Modify: `src/mcp/index.ts` (add singleton accessor)
- Modify: `src/runtime.ts` (set singleton)

- [ ] **Step 1: Add singleton accessor to src/mcp/index.ts**

Add to the end of the file:

```typescript
import type { McpManager } from './manager';

let _managerInstance: McpManager | null = null;

export function setMcpManagerInstance(manager: McpManager | null): void {
  _managerInstance = manager;
}

export function getMcpManagerInstance(): McpManager | null {
  return _managerInstance;
}
```

- [ ] **Step 2: Set singleton in src/runtime.ts**

After `mcpManager = new McpManager(...)` line, add:

```typescript
      import('./mcp/index').then(m => m.setMcpManagerInstance(mcpManager!));
```

Or, simpler — add import at top and call directly:

```typescript
import { setMcpManagerInstance } from './mcp/index';
```

Then after `mcpManager = new McpManager(...)`:

```typescript
      setMcpManagerInstance(mcpManager);
```

And in the error catch block, add `setMcpManagerInstance(null);`.

- [ ] **Step 3: Extend CommandHandlerContext**

In `src/cli/tui/types.ts`, add to the interface:

```typescript
  mcpManager?: import('../../../mcp/manager').McpManager;
```

Remove the existing import of McpManager at the top of the file (keep the file clean, use inline import).

- [ ] **Step 4: Write TUI MCP commands**

Create `src/cli/tui/commands/mcp-commands.ts`:

```typescript
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
            const icon = state.status === 'connected' ? '\u2713'
              : state.status === 'error' ? '\u2717'
              : state.status === 'connecting' ? '\u2026'
              : '\u25CB';
            const detail = state.status === 'connected'
              ? `${state.capabilities.tools.length}t ${state.capabilities.resources.length}r ${state.capabilities.prompts.length}p`
              : state.status === 'error' ? state.message : '';
            lines.push(`  ${icon} ${name} [${state.status}]${detail ? ` \u2014 ${detail}` : ''}`);
          }
          ctx.onOutput(lines.join('\n'));
          break;
        }
        case 'mcp-add': {
          const jsonStr = ctx.args.trim();
          if (!jsonStr) {
            ctx.onOutput('Usage: /mcp-add {"name":"srv","transport":"stdio","command":"npx","args":["-y","@scope/package"]}');
            return;
          }
          try {
            const config = JSON.parse(jsonStr);
            await manager.connectServer(config);
            ctx.onOutput(`Connected to '${config.name}'. Tools and prompts registered.`);
          } catch (err) {
            ctx.onOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case 'mcp-remove': {
          const name = ctx.args.trim();
          if (!name) {
            ctx.onOutput('Usage: /mcp-remove <server-name>');
            return;
          }
          if (!manager.hasServer(name)) {
            ctx.onOutput(`Server '${name}' not found.`);
            return;
          }
          await manager.removeServer(name);
          ctx.onOutput(`Removed MCP server '${name}'.`);
          break;
        }
        case 'mcp-disconnect': {
          const name = ctx.args.trim();
          if (!name) {
            ctx.onOutput('Usage: /mcp-disconnect <server-name>');
            return;
          }
          await manager.disconnectServer(name);
          ctx.onOutput(`Disconnected from '${name}'.`);
          break;
        }
        case 'mcp-connect':
          ctx.onOutput('Use /mcp-add with a JSON config to connect to a new server.');
          break;
      }
    },
  }));
}
```

- [ ] **Step 5: Register MCP commands in getBuiltinCommands**

In `src/cli/tui/command-registry.ts`, add import:

```typescript
import { getMcpCommands } from './commands/mcp-commands';
```

Modify `getBuiltinCommands`:

```typescript
export function getBuiltinCommands(sessionStore: SessionStore): SlashCommand[] {
  const { getSessionCommands } = require('./commands/session-commands');
  return [
    ...BASE_COMMANDS,
    compactCommand,
    costCommand,
    toolsCommand,
    ...getSessionCommands(sessionStore),
    ...getMcpCommands(),
  ];
}
```

- [ ] **Step 6: Pass mcpManager to CommandHandlerContext in App.tsx**

In `src/cli/tui/App.tsx`, add import at top:

```typescript
import { getMcpManagerInstance } from '../../../mcp/index';
```

In `buildV2CommandContext` function (~line 39), add to the returned object:

```typescript
    mcpManager: getMcpManagerInstance() ?? undefined,
```

The function now returns:

```typescript
  return {
    agent,
    sessionStore,
    args,
    mcpManager: getMcpManagerInstance() ?? undefined,
    onOutput: (content) => useTuiStore.getState().appendSystemNotice(`notice-${noticIdx.current++}`, content),
    refreshMessages: () => {
      const cm = agent.getContextManager?.();
      const msgs = cm?.getMessages?.() ?? [];
      useTuiStore.getState().resetFromMessages(msgs);
      useTuiStore.getState().setContextTokens(cm?.getCurrentTokens() ?? 0);
    },
  };
```

- [ ] **Step 7: Verify compilation**

Run: `bun run tsc`

- [ ] **Step 8: Commit**

```bash
git add src/mcp/index.ts src/runtime.ts src/cli/tui/types.ts src/cli/tui/commands/mcp-commands.ts src/cli/tui/command-registry.ts src/cli/tui/App.tsx
git commit -m "feat: wire MCP into TUI with slash commands and status display"
```

---

### Task 13: End-to-end verification and final commit

- [ ] **Step 1: Run full test suite**

Run: `bun test`

- [ ] **Step 2: Run architecture check**

Run: `bun run check:arch`

- [ ] **Step 3: Run type check**

Run: `bun run tsc`

- [ ] **Step 4: Fix any issues**

Address any failures from steps 1-3.

- [ ] **Step 5: Ensure index.ts exports are complete**

Verify `src/mcp/index.ts` exports everything that external consumers need (runtime, CLI, TUI all import from here).

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: finalize MCP client implementation"
```
