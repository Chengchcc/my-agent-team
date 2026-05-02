# MCP Client 实现设计

## 概述

为 agent 框架实现 MCP (Model Context Protocol) Client 角色，使其能连接外部 MCP server，发现并调用其 tools/resources/prompts。

## 范围

- **角色**: MCP Client
- **传输**: stdio + SSE/HTTP + Streamable HTTP
- **能力**: tools + resources + prompts 全集成
- **配置**: settings.json 持久化 + CLI 子命令管理 + agent 内 tool 动态添加
- **模式**: Headless + TUI 双模式支持

---

## 架构

```
settings.json / CLI --mcp-server
       │
       ▼
McpManager (连接生命周期 + 能力聚合)
  ├─ StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
  ├─ McpToolAdapter → ToolRegistry
  ├─ McpResourceMiddleware → AgentHooks.beforeModel
  └─ McpPromptRegistry → ToolRegistry (prompts as tools)
```

### 设计原则

- 复用现有 `ToolImplementation` / `ToolMiddleware` / `AgentHooks` 接口
- 不修改 `ToolDispatcher`（Constitution §D 冻结）
- MCP tools 对 agent 透明——与内置 tools 在同一 `ToolRegistry` 中共存
- 单 server 失败不影响其他 server

---

## 模块

### 1. 配置类型 (`src/config/types.ts`)

```typescript
export interface McpServerConfig {
  name: string;                              // 唯一标识，用于 tool 前缀
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;                          // stdio
  args?: string[];
  url?: string;                              // SSE / HTTP
  headers?: Record<string, string>;
  env?: Record<string, string>;
  autoStart?: boolean;                       // 默认 true
}

export interface McpSettings {
  enabled: boolean;
  servers: McpServerConfig[];
  toolTimeoutMs: number;                     // 默认 30000
  reconnectAttempts: number;                 // 默认 3
  reconnectDelayMs: number;                  // 默认 1000
}
```

`Settings` 根接口加 `mcp: McpSettings`。

### 2. 运行时类型 (`src/mcp/types.ts`)

```typescript
export type McpConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; capabilities: McpCapabilities; startedAt: number }
  | { status: 'error'; message: string; since: number };

export interface McpCapabilities {
  tools: McpToolDef[];
  resources: McpResourceDef[];
  prompts: McpPromptDef[];
}

export interface McpToolDef {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;       // JSON Schema
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptResult {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}
```

### 3. 连接管理器 (`src/mcp/manager.ts`)

`McpManager` 类，管理所有 MCP server 连接生命周期。

**公共接口**:

```
start(): Promise<void>                              // 连接所有 autoStart !== false 的 server
connectServer(config: McpServerConfig): Promise<void>  // 连接单个 server（不负责注册 tool）
disconnectServer(name: string): Promise<void>
removeServer(name: string): Promise<void>           // 断开 + 从内部 map 移除
shutdown(): Promise<void>
hasServer(name: string): boolean
getConnectionStates(): ReadonlyMap<string, McpConnectionState>
getAllTools(): Array<{ serverName: string; tool: McpToolDef }>
getAllResources(): Array<{ serverName: string; resource: McpResourceDef }>
getAllPrompts(): Array<{ serverName: string; prompt: McpPromptDef }>
getServerTools(name: string): McpToolDef[]
getServerPrompts(name: string): McpPromptDef[]
executeTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<unknown>
readResource(serverName: string, uri: string): Promise<unknown>
getPrompt(serverName: string, promptName: string, args: Record<string, string>): Promise<McpPromptResult>
```

**重要**: `connectServer()` 只负责连接和能力发现，不自动注册 tool/prompt 到 ToolRegistry。注册由调用方负责——启动时由 `createAgentRuntime()` 注册，动态添加时由 `McpAddServerTool` 注册。

**内部**:

- `_servers: Map<string, McpClientEntry>` — 每个 entry 包含 `{ config, client: Client, transport, state }`
- Transport 按 config.transport 选择: `StdioClientTransport` / `SSEClientTransport` / `StreamableHTTPClientTransport`
- 连接成功后调用 `client.listTools()` / `client.listResources()` / `client.listPrompts()` 缓存能力
- 重连: fibonacci 退避，最多 `reconnectAttempts` 次
- 单 server 失败不影响其他，每个独立状态

### 4. 工具适配器 (`src/mcp/tool-adapter.ts`)

将 MCP tool 包装为 `ToolImplementation`。

**命名规则**: `mcp__<serverName>__<toolName>`

**类型安全**: `CallToolResult.content` 遍历时显式 narrow `TextContent | ImageContent | EmbeddedResource`，不用 `as any`。

**readonly 判断**: `list_*`、`read_*`、`search_*`、`get_*` 前缀的工具标为 readonly。

**注册时机**: 由调用方在 `connectServer()` 成功后遍历 `getAllTools()` 批量创建。不存在"自动注册"——Manager 只管理连接和能力缓存，不触碰 ToolRegistry。

### 5. 资源中间件 (`src/mcp/resource-middleware.ts`)

`beforeModel` hook，将资源目录注入 `ephemeralReminders`。

- 只列目录（URI + name + description），不实际读取内容
- 超过 `MAX_RESOURCES_INJECTED`（50）时截断并备注
- 仅在 manager 缓存中资源变化时重新格式化

### 6. 提示注册表 (`src/mcp/prompt-registry.ts`)

管理 MCP prompts，暴露为 tool 供 agent 调用。

- 每个 prompt 包装为 `ToolImplementation`，命名规则 `mcp__<server>__prompt__<promptName>`
- execute 调用 `manager.getPrompt()`，返回填充后的 role/content 消息
- LLM 通过 tool 定义列表直接感知 prompt（无需额外 middleware，tool 定义即目录）
- `registerAsTool(name, promptDef, toolRegistry)` — 供 startup 和动态 add 复用

### 7. MCP 管理工具 (`src/mcp/tools.ts`)

Agent 对话中动态管理的 tool 集合:

| Tool | 用途 | 是否持久化 |
|------|------|-----------|
| `mcp_add_server` | 添加并连接 server | ❌ 仅会话 |
| `mcp_remove_server` | 断开并移除 server | ❌ 仅会话 |
| `mcp_list_servers` | 列出所有 server 状态 | — |

`mcp_add_server` 参数: name, transport, command?, args?, url?, headers?, env?。

执行流程: `manager.connectServer(config)` → 遍历 `getServerTools()` 逐个 `new McpToolAdapter()` 注册 → 遍历 `getServerPrompts()` 逐个 `promptRegistry.registerAsTool()` 注册。

### 8. 事件扩展 (`src/agent/loop-types.ts`)

```typescript
| { type: 'mcp_status'; serverName: string; status: 'connected' | 'disconnected' | 'connecting' | 'error'; error?: string; toolCount?: number }
```

### 9. Runtime 组装 (`src/runtime.ts`)

`RuntimeConfig` 扩展: `enableMcp?: boolean`、`mcpServers?: McpServerConfig[]`（CLI 追加）。

`AgentRuntime` 扩展: `mcpManager?: McpManager`（暴露给 TUI 命令层）。

`createAgentRuntime()` 流程:
1. 合并 `settings.mcp.servers + runtimeConfig.mcpServers`（同名 CLI 覆盖）
2. `enableMcp === false || servers.length === 0` → 跳过
3. `new McpManager(servers, options)` → `await manager.start()`
4. 遍历 `manager.getAllTools()` → `toolRegistry.register(new McpToolAdapter(...))`
5. `hooks.beforeModel.push(createMcpResourceMiddleware(manager).beforeModel)`
6. 遍历 `manager.getAllPrompts()` → 注册为 tool
7. 注册 `McpAddServerTool`、`McpRemoveServerTool`、`McpListServersTool`
8. `hooks.afterAgentRun.push` manager shutdown

### 10. Headless CLI (`bin/my-agent.ts` + `bin/mcp-cli.ts`)

**Agent 模式**（对话中运行）:

```
--no-mcp                  禁用 MCP
--mcp-server '<json>'     追加 server（可重复）
--mcp-server-file <path>  从文件批量添加
--mcp-debug               在 stderr 输出 MCP 连接/tool 详情
```

**子命令模式**（配置管理，不启动 agent loop）:

```
my-agent mcp list                    列出所有 server 及状态
my-agent mcp status <name>           详情（tools/resources/prompts 数量）
my-agent mcp add <name> [opts]      添加并持久化到 settings.json
my-agent mcp remove <name>           从 settings.json 移除
my-agent mcp connect <name>          测试连接
my-agent mcp disconnect <name>       断开连接
```

`my-agent mcp add` 参数: `--transport`、`--command`、`--args`、`--url`、`--header`、`--env`、`--no-auto-start`。

`bin/mcp-cli.ts` 直接读写 settings.json 实现持久化。

### 11. TUI 命令 (`src/cli/tui/commands/mcp-commands.ts`)

`CommandHandlerContext` 加 `mcpManager?: McpManager`。

| 命令 | 用途 |
|------|------|
| `/mcp` | 展示 server 列表 + 连接状态 + 能力统计 |
| `/mcp-add <json>` | 添加并连接 server，同时持久化到 settings.json |
| `/mcp-remove <name>` | 断开、移除、并从 settings.json 删除 |
| `/mcp-connect <name>` | 手动连接 |
| `/mcp-disconnect <name>` | 手动断开 |

Footer 展示: `MCP: 3 connected, 1 error`（通过 `mcp_status` 事件更新）。

---

## 目录结构

```
src/mcp/
  ├── index.ts               公共导出
  ├── types.ts               运行时类型
  ├── manager.ts             McpManager 连接管理器
  ├── tool-adapter.ts        McpToolAdapter
  ├── resource-middleware.ts 资源注入中间件
  ├── prompt-registry.ts     Prompt 注册表
  └── tools.ts               mcp_add_server / mcp_remove_server / mcp_list_servers

src/config/types.ts          + McpServerConfig, McpSettings
src/runtime.ts               组装集成
src/agent/loop-types.ts      + mcp_status 事件
src/cli/tui/types.ts         + CommandHandlerContext.mcpManager
src/cli/tui/commands/mcp-commands.ts  TUI MCP 命令

bin/my-agent.ts              --no-mcp, --mcp-server, --mcp-server-file, --mcp-debug, mcp 子命令分发
bin/mcp-cli.ts               MCP 配置管理逻辑（CRUD + 持久化）
```

## 依赖

- `@modelcontextprotocol/sdk` — 提供 `Client` + 三种 `Transport`

## Constitution 合规

| 条款 | 状态 | 说明 |
|------|------|------|
| §A Assembly | ✅ | McpManager 在 createAgentRuntime() 中创建 |
| §B Type Safety | ✅ | CallToolResult.content 显式 narrow，零 any |
| §C Hook Freeze | ✅ | 只用 beforeModel |
| §D ToolDispatcher Freeze | ✅ | 零修改 |
| §E State Consistency | ✅ | Manager 自管状态 |
| §F DRY | ✅ | tool-adapter 不重复 SubAgentTool 逻辑 |
| §G Size Control | ✅ | 每个文件 < 200 行 |
| §H Testing | ✅ | 每个 public export 配单元测试 |
| §I Forbidden Patterns | ✅ | debugLog，命名常量，无 magic numbers |

## 测试策略

- `manager.test.ts`: 连接/断开/重连/错误隔离（mock transport）
- `tool-adapter.test.ts`: 命名转换、返回值解包、readonly 判断
- `resource-middleware.test.ts`: 资源格式化、截断、ephemeralReminders 注入
- `tools.test.ts`: mcp_add_server / mcp_remove_server / mcp_list_servers 逻辑
- `integration/mcp-e2e.test.ts`: 端到端（需要真实 MCP server 或 mock server）
