# My-Agent: Design & Architecture

A terminal-native AI coding agent built with TypeScript and Bun. It combines an extensible agent loop, a rich Ink/React TUI, persistent memory, skill injection, tiered context compaction, and a composable tool dispatch system into a single CLI application.

---

## Table of Contents

- [Overview](#overview)
- [Project Structure](#project-structure)
- [Runtime Assembly](#runtime-assembly)
- [Configuration](#configuration)
- [Core Types](#core-types)
- [The Agent Loop](#the-agent-loop)
- [Context & Token Management](#context--token-management)
- [Tool System](#tool-system)
- [Tool Dispatch Pipeline](#tool-dispatch-pipeline)
- [Context Compaction](#context-compaction)
- [Providers](#providers)
- [Sub-Agent Delegation](#sub-agent-delegation)
- [Memory System](#memory-system)
- [Skills System](#skills-system)
- [Todo System](#todo-system)
- [Session System](#session-system)
- [Trace System](#trace-system)
- [Self-Evolution System](#self-evolution-system)
- [Terminal UI (TUI)](#terminal-ui-tui)
- [Data Flow](#data-flow)
- [Architecture Rules](#architecture-rules)
---

## Terminology

| Term | Definition |
|------|-----------|
| **Run** | A single `agent.runAgentLoop()` invocation — one complete agent session from user input to final response. Created in `beforeAgentRun`, finalized in `afterAgentRun`. |
| **Turn** | One LLM invocation + its tool executions. A run contains multiple turns. |
| **Tool Execution** | A single tool call within a turn. Has name, success/failure, duration, and optional error message. |
| **Trace** | The structured record of a run (TraceRun): all turns, tool executions, token usage, timing, and outcome. Persisted as NDJSON in `~/.my-agent/traces/`. |
| **Nudge** | A signal generated after a run completes, indicating the trace contains a pattern worth reviewing. Three types: error burst, complex task, periodic. |
| **Review Agent** | A lightweight background agent (Phase 2) that analyzes a trace when a nudge fires, producing auto-generated skills. |
| **Auto Skill** | A skill created by the Review Agent in `~/.my-agent/skills/auto/`. Tracked for effectiveness; user can approve or delete via `/review`. |
| **Effectiveness Score** | `successful_runs / total_runs_with_skill` for an auto skill. Low scores trigger Tier 2 LLM analysis (Phase 3). |
| **Evolution** | The full closed loop (trace → nudge → review → skill → measurement → feedback) that enables the agent to self-improve over time. |
| **Agent Loop** | The async generator in `Agent.runAgentLoop()` that cycles through Phase 1 (setup) → Phase 2 (LLM turn) → Phase 3 (tool execution) → repeat/teardown. |
| **Middleware (Agent)** | Onion-pattern hooks: `beforeAgentRun`, `beforeCompress`, `beforeModel`, `afterModel`, `beforeAddResponse`, `afterAgentRun`. |
| **Middleware (Tool)** | Onion-pattern tool wrappers: `PermissionMiddleware` → `ReadCacheMiddleware` → `TraceToolMiddleware` → `tool.execute()`. |
| **Compaction** | Multi-tier context compression: snip → summarize → emergency truncate → collapse. Triggered when token usage exceeds thresholds. |
| **Ephemeral Reminder** | Injected context that does not persist in message history (e.g., retrieved memories, MCP resource catalogs). |

---

## Overview

My-Agent is an AI assistant that runs in your terminal. You type instructions, it reasons about them, calls tools (reading files, running commands, searching code), and responds. It can remember things across sessions, learn domain-specific skills, manage task lists, and delegate complex work to sub-agents — all while keeping the conversation within token limits through a multi-tier compaction system.

The project has two run modes:

- **Headless** (`bin/my-agent.ts`) — runs the agent loop without a UI, useful for scripting
- **TUI** (`bin/my-agent-tui-dev.ts`) — full interactive terminal interface with streaming output, syntax highlighting, and tool status display

---

## Project Structure

```
my-agent/
  bin/                        # CLI entry points (thin wrappers, no logic)
  src/
    agent/                    # Core agent loop and orchestration
      compaction/             # Multi-tier context compression
      tool-dispatch/          # Tool execution pipeline
        middlewares/          # Permission, caching middleware
    cli/tui/                  # Ink/React terminal UI
      components/             # React components (ChatMessage, InputBox, Footer, etc.)
      hooks/                  # State management, agent loop integration
      utils/                  # Tool output formatting
    config/                   # YAML-based configuration system
    evolution/                # Self-evolution: review agent, effectiveness tracking, skill analysis
    mcp/                      # MCP client (server lifecycle, tool adapter, prompts, resources)
    memory/                   # Persistent memory (semantic, episodic, project)
    providers/                # LLM providers (Claude, OpenAI)
    session/                  # Conversation session persistence
    skills/                   # Skill file loading and injection
    todos/                    # Task list management
    tools/                    # Built-in tool implementations
    trace/                    # Trace recording: buffer, store, redactor, nudge engine, middleware
    utils/                    # Shared utilities (debug logging, file detection)
    runtime.ts                # Single assembly point for the full agent runtime
    types.ts                  # Shared type definitions
  tests/                      # Test suite (mirrors src/ structure)
  skills/                     # Skill definition files (SKILL.md per skill)
```

---

## Runtime Assembly

Everything wires together in one place: `src/runtime.ts` exports a single function, `createAgentRuntime()`. This is the **only** way to assemble the application. CLI entry points in `bin/` parse arguments and call it — they never construct core objects directly.

```typescript
const { agent, provider, toolRegistry, contextManager, sessionStore, shutdown } =
  await createAgentRuntime({ tokenLimit, defaultSystemPrompt, hooks });
```

The assembly process:

1. **Create a Provider** (Claude or OpenAI) from settings and environment variables
2. **Build the compaction manager** (multi-tier compression if enabled)
3. **Create the ContextManager** — the message store and token budget tracker
4. **Build the ToolRegistry** and register all built-in tools (bash, read, grep, glob, ls, text_editor, ask_user_question)
5. **Wire up Todo** — creates the `todo_write` tool and a middleware that injects reminders
6. **Create and register the SubAgentTool** — isolates tool registry to prevent recursive spawning
7. **Assemble MCP Client** — load server configs from settings, connect to each (concurrency-controlled: max 4 stdio), wrap tools/prompts/resources, register as regular tools via the adapter pattern
8. **Set up Memory** — three JSONL stores (semantic, episodic, project), keyword retriever, LLM extractor, and injection middleware
9. **Set up Skills** — loads `SKILL.md` files, creates middleware that lists them for the model
10. **Set up Session** — auto-save hook persists conversation after each run
11. **Build the tool middleware chain** — Permission guard, ReadCache, then Trace tool middleware
12. **Wire Trace** — createTraceMiddleware for trace recording + NudgeEngine
13. **Wire Evolution** — initEvolution for background review + effectiveness tracking (if enabled)
14. **Create the Agent** with all components
15. **Return** the assembled runtime

The `AgentRuntime` interface exposes everything callers need — `agent`, `provider`, `toolRegistry`, `contextManager`, `sessionStore`, `memoryMiddleware`, `skillLoader`, `mcpManager` (if MCP enabled), and `shutdown`.

---

## Configuration

The configuration system loads settings from three layers (lowest to highest priority):

1. **Built-in defaults** (`src/config/defaults.ts`) — sensible values for all settings
2. **Project config** (`./settings.yml`) — per-repository overrides
3. **User config** (`~/.my-agent/settings.yml`) — personal preferences
4. **Environment variables** — `MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEBUG` etc.

All settings are validated through Zod schemas (`src/config/schema.ts`). The `getSettings()` function caches the loaded config after first access.

### Key Settings Groups

| Group | What it controls |
|-------|-----------------|
| `llm` | Provider, model, API key, base URL, max tokens, temperature |
| `context` | Token limit, budget guard thresholds |
| `memory` | Base directory, max entries per store, extraction model |
| `skills` | Base directory, auto-injection, inject-on-mention |
| `mcp` | Enabled, server list, tool timeout, reconnect attempts/delay |
| `tui` | Input history (enabled, max lines), session directory |
| `subAgent` | Auto-trigger threshold, worktree isolation |
| `security` | Allowed filesystem roots |
| `compaction` | Thresholds, summary provider/model, enabled tiers |
| `trace` | Trace recording (enabled, max runs, redaction mode, nudge, review settings) |

---

## Core Types

The shared type system lives in `src/types.ts`. The most important types:

- **`Message`** — Unified message with `role` (system/user/assistant/tool), `content`, optional `tool_calls` and `tool_call_id`. Every message gets a nanoid.
- **`AgentContext`** — The context object that flows through every hook and middleware. Contains `messages[]`, `config`, `metadata` (including todo state), optional `systemPrompt` and `response`.
- **`Provider`** — Interface for LLM backends: `registerTools()`, `stream()`, `getModelName()`.
- **`Middleware`** — Onion-style hook: `(ctx, next) => Promise<AgentContext>`.
- **`AgentHooks`** — Six hook points: `beforeAgentRun`, `beforeCompress`, `beforeModel`, `afterModel`, `beforeAddResponse`, `afterAgentRun`.
- **`ToolCall`** — `id`, `name`, `arguments` (the arguments are passed to the tool implementation).
- **`ToolImplementation`** — Interface for tools: `getDefinition()` returns JSON Schema, `execute(params, ctx)` runs the tool.
- **`ToolContext`** — Per-tool execution environment: abort signal, budget info, cwd, agent type, side-effect sink.

---

## The Agent Loop

The central execution engine is `Agent.runAgentLoop()` in `src/agent/Agent.ts`. It's an **async generator** that yields `AgentEvent` objects, consumed by the TUI or headless runner.

### Four-Phase Architecture

**Phase 1 — Setup (`runSetup`)**
- Adds the user's message to the context
- Runs `beforeAgentRun` hooks (skills pre-load, session init)

**Phase 2 — LLM Turn (`runSingleTurn`)**
- Runs `beforeCompress` hooks, then checks if context needs compaction
- Runs `beforeModel` hooks (skill injection, memory retrieval, todo reminders)
- Streams from the provider, yielding `text_delta` events as they arrive
- Runs `afterModel` and `beforeAddResponse` hooks
- Adds the assistant's response (including any tool calls) to context
- Returns `{ toolCalls, done }` — done is true if the model responded without tool calls

**Phase 3 — Tool Execution (`runTools`)**
- Runs budget guard to check if there's enough context space for tool output
- If budget is tight: may delegate to a sub-agent or compact first
- Dispatches tools through the `ToolDispatcher`, yielding `tool_call_start` and `tool_call_result` events
- Adds tool results to context
- If `toolErrorStrategy` is `halt` and a tool fails, throws immediately

**Phase 4 — Teardown (`runTeardown`)**
- Runs `afterAgentRun` hooks (memory extraction, session auto-save)
- Yields `agent_done` with the completion reason

### Loop Configuration

| Setting | Default | Purpose |
|---------|---------|---------|
| `maxTurns` | 25 | Max conversation turns |
| `timeoutMs` | 600000 | Overall loop timeout (10 min) |
| `toolTimeoutMs` | 120000 | Per-tool timeout (2 min) |
| `maxToolOutputChars` | 102400 | Truncation threshold (100 KB) |
| `parallelToolExecution` | true | Run independent tools in parallel |
| `yieldEventsAsToolsComplete` | true | Stream results as they finish |
| `toolErrorStrategy` | `continue` | `continue` or `halt` on tool error |

### Event Types

The loop yields a discriminated union of 12 event types:

| Event | When |
|-------|------|
| `text_delta` | Each chunk of streaming LLM output |
| `tool_call_start` | Tool execution begins |
| `tool_call_result` | Tool execution completes (includes duration, result, errors) |
| `turn_complete` | LLM turn finishes (includes token usage) |
| `agent_done` | Entire loop complete |
| `agent_error` | Fatal error in the loop |
| `sub_agent_start` | Sub-agent delegation begins |
| `sub_agent_event` | Events from within a sub-agent |
| `sub_agent_done` | Sub-agent delegation completes |
| `budget_delegation` | Budget guard redirected a tool to a sub-agent |
| `budget_compact` | Budget guard triggered context compaction |
| `context_compacted` | Context was compressed (includes token counts) |

---

## Context & Token Management

`ContextManager` (`src/agent/context.ts`) is the conversation's memory. It manages:

- **Message storage** — the full conversation history
- **Token counting** — incremental cache for O(1) budget reads
- **System prompt** — dynamic injection point for skills and memory
- **Todo state** — task list that persists alongside messages
- **Compression** — delegates to the compaction strategy when over budget

### Incremental Token Cache

A key performance optimization: rather than re-counting all message tokens every time the budget guard checks remaining space (which was O(N) and blocked the event loop for ~1-2 seconds on large conversations), the cache updates incrementally. When a message is added, only that message's tokens are counted and added to the running total. The full recount only happens on infrequent operations (compaction, system prompt changes, clear).

### Budget Methods

- `getRemainingBudget()` — how many tokens are left before hitting the limit
- `getUsageRatio()` — 0-1 ratio of used to total
- `getAccumulatedOutputTokens()` — total output tokens across all turns

---

## Tool System

### Base Class

All tools extend `ZodTool<T>` (`src/tools/zod-tool.ts`), which converts Zod schemas to JSON Schema for LLM function calling definitions. The `execute()` method validates arguments against the schema, then delegates to the abstract `handle()` method.

### Built-in Tools

| Tool | Description |
|------|-------------|
| **bash** | Executes shell commands with timeout, output truncation, working directory restrictions |
| **read** | Reads files with line ranges, encoding detection, binary file detection |
| **grep** | Text/regex search with file filtering, context lines |
| **glob** | Find files by pattern with exclusions and depth limits |
| **ls** | List directory contents with sorting and metadata |
| **text_editor** | View, create, string-replace, and write file operations |
| **ask_user_question** | Present multi-choice questions to the user (1-4 parallel questions) |
| **memory** | Search, add, list, forget, and consolidate memories |
| **todo_write** | Task list management with merge behavior |
| **sub_agent** | Delegate self-contained tasks to an isolated sub-agent |
| **mcp_list_servers** | List all configured MCP servers and their connection status |
| **mcp_add_server** | Connect to a new MCP server and register its tools/prompts (persisted to settings) |
| **mcp_remove_server** | Disconnect and unregister an MCP server (persisted to settings) |
| **mcp_read_resource** | Read MCP resource contents by server name and URI |

### What Makes a Tool?

Each tool implements `ToolImplementation`:

```typescript
interface ToolImplementation<TParams = unknown, TResult = unknown> {
  getDefinition(): Tool;       // JSON Schema for the LLM
  execute(params: TParams, ctx: ToolContext): Promise<TResult>;
}
```

The `ToolContext` provides the tool with an abort signal, a read-only snapshot of the agent's context, budget information, the current working directory, and a side-effect sink (for tools like `todo_write` that modify state beyond their return value).

---

## Tool Dispatch Pipeline

`ToolDispatcher` (`src/agent/tool-dispatch/dispatcher.ts`) manages tool execution with three modes:

1. **Sequential** — one at a time, yields `start` then `result` for each
2. **Parallel Batch** — all start at once via `Promise.allSettled`, yield results after all complete
3. **Parallel Streaming** — all start at once, yield each result as it completes via `ReadableStream`

### Middleware Chain

Tool middleware follows the same onion pattern as agent hooks:

```
PermissionMiddleware → ReadCacheMiddleware → tool.execute()
```

- **PermissionMiddleware** — blocks `sub_agent` and `ask_user_question` tools in sub-agent contexts (prevents recursion and nested prompts)
- **ReadCacheMiddleware** — caches file reads keyed by (path, line range, mtime) with LRU eviction at 100 entries

Each middleware can short-circuit by not calling `next()`, or modify the result before returning.

---

## MCP Client

The agent can connect to external tools, resources, and prompts via the [Model Context Protocol](https://modelcontextprotocol.io/). Each connected MCP server's capabilities are adapted into the agent's native tool system.

### Design: `xxx-as-Tool`

A core design pattern: MCP resources are not separate abstractions — everything is a tool. The LLM only knows `function_call`, so every MCP capability must be discoverable and invocable through the tool interface:

| MCP Capability | How it becomes a tool |
|----------------|----------------------|
| **Tools** | Each MCP server tool becomes a `McpToolAdapter` registered as `mcp__<server>__<tool>`. Calls are forwarded through the SDK Client to the external server. |
| **Prompts** | MCP prompts are registered as standalone tools via `McpPromptRegistry.registerAsTool()`. When invoked, the prompt template is filled with the model's arguments server-side and the result is returned like a tool output. |
| **Resources** | A `createMcpResourceMiddleware()` injects a resource catalog into `ephemeralReminders` via the `beforeModel` hook, so the model knows what's available. A dedicated `mcp_read_resource` tool lets the model fetch resource contents by `<server, uri>`. |
| **Server management** | Three management tools (`mcp_list_servers`, `mcp_add_server`, `mcp_remove_server`) give the LLM self-service access to add/remove/list MCP servers at runtime. |

### Concurrency Control

`stdio` transports are process-spawning operations. To avoid resource spikes at startup, `McpManager.start()` uses `p-limit` to cap concurrent stdio connections at `MAX_STDIO_CONNECTIONS` (4). SSE and streamable-http connections are not limited.

### Failure Recovery

When a connected server's transport closes unexpectedly (`transport.onclose`), `McpManager` marks it as `error`, then attempts automatic reconnection with **exponential backoff**: `baseDelay * attempt` for up to `reconnectAttempts` (default 3). Explicit disconnects (`/mcp-disconnect`) suppress this — they mark the state as `disconnected` before closing the transport.

### Lifecycle

1. **Startup**: `assembleMcp()` reads `mcp.servers` from settings, creates `McpManager`, connects all servers with `autoStart !== false`.
2. **Runtime**: `McpManager` is stored as a singleton (`setMcpManagerInstance`) so TUI slash commands can access it. Tools and prompts are registered into the shared `ToolRegistry` and `McpPromptRegistry`.
3. **Adding servers**: Both the `/mcp-add` TUI slash command and the `mcp_add_server` AI tool call `manager.connectServer()`, register resulting tools/prompts, and persist the server config to `~/.my-agent/settings.yml` so it survives restarts.
4. **Shutdown**: `runtime.shutdown()` calls `manager.shutdown()` which disconnects all servers and clears the singleton references.

### Signal Propagation

`McpToolAdapter.execute()` forwards `ctx.signal` (the agent's abort signal) through to the SDK's `client.callTool()` as `RequestOptions.signal`. This means aborting the agent run also cancels in-flight MCP tool calls.

### Transport Types

| Transport | Use case | Connection |
|-----------|---------|------------|
| `stdio` | Local MCP servers (spawned as child processes) | `StdioClientTransport` with command + args, env inheritance from `process.env` merged with optional `config.env` |
| `sse` | Remote MCP servers over Server-Sent Events | `SSEClientTransport` at a URL |
| `streamable-http` | Remote MCP servers over the newer streamable HTTP protocol | `StreamableHTTPClientTransport` at a URL |

### TUI Integration

Five slash commands manage MCP at runtime:

| Command | Function |
|---------|----------|
| `/mcp` | Show all server connection states with tool/resource/prompt counts |
| `/mcp-add <json>` | Add and connect a server; persist to `~/.my-agent/settings.yml` |
| `/mcp-remove <name>` | Disconnect, unregister tools, and remove from settings |
| `/mcp-connect <name>` | Reconnect a previously added server |
| `/mcp-disconnect <name>` | Disconnect but keep tools registered (soft disconnect) |

### Tool Naming Convention

MCP tools are prefix-namespaced: `mcp__<server_name>__<tool_name>`. Server names must not contain `__` (enforced by Zod validation). The `conflictKey` for write-tool serialization is `mcp:<serverName>`, ensuring tools from different servers can execute concurrently while tools within the same server are serialized.

---

## Context Compaction

When the conversation grows too large for the model's context window, the compaction system reduces it. It uses a **least-destructive-first** approach with five tiers:

| Tier | When | Strategy |
|------|------|----------|
| 0 — None | < 60% usage | No action needed |
| 1 — Snip | 60-75% | Truncate large tool outputs (keep head 40 + tail 10 lines) |
| 2 — AutoCompact | 75-95% | LLM summarizes old messages with a cheap model |
| 3 — Reactive | API error | Emergency: aggressive truncation when API returns `context_length_exceeded` |
| 4 — Collapse | > 95% | Nuclear: system prompt + summary + last 2 messages only |

The system also includes a fallback `TrimOldestStrategy` that removes old messages while preserving the current turn (an assistant message with tool calls is always removed together with its tool results).

---

## Providers

Two LLM backends implement the `Provider` interface:

- **ClaudeProvider** (`src/providers/claude.ts`) — wraps `@anthropic-ai/sdk`, converts internal message format to Claude API format, system prompt extracted separately
- **OpenAIProvider** (`src/providers/openai.ts`) — parallel implementation for OpenAI-compatible APIs

The factory `createProviderFromSettings()` selects the provider based on settings, with API key fallback to environment variables.

---

## Sub-Agent Delegation

`SubAgentTool` (`src/agent/sub-agent-tool.ts`) spawns an independent agent to handle self-contained tasks. Key design decisions:

- **Filtered tool registry** — sub-agents cannot spawn further sub-agents (prevents recursion) and cannot ask user questions
- **Isolated context** — fresh `ContextManager` with its own message history
- **Smaller context window** — sub-agents get a reduced token limit
- **Abort propagation** — aborting the parent aborts all sub-agents
- **Event bubbling** — sub-agent events are wrapped and forwarded to the parent's event stream

Sub-agents can also be triggered automatically by the budget guard when a large read or search would consume too much of the main conversation's remaining token budget.

---

## Memory System

The agent can remember information across sessions using three memory stores:

| Store | What it holds | Typical entries |
|-------|--------------|-----------------|
| **Semantic** | User preferences, coding style, reusable knowledge | ~200 entries |
| **Episodic** | Past conversations, decisions, debugging sessions | ~500 entries |
| **Project** | Project-specific facts, architecture notes | ~50 entries |

### Architecture

1. **Storage** — `JsonlMemoryStore` uses JSONL files (semantic, episodic) and JSON files (project) in `~/.my-agent/memory/`
2. **Retrieval** — `KeywordRetriever` tokenizes queries into English words and Chinese characters, scores by keyword match (40%), tag match (30%), recency (20%), weight (10%)
3. **Extraction** — `LlmExtractor` uses a cheap model (e.g., Haiku) to extract memories from conversation and consolidate duplicates
4. **Injection** — `MemoryMiddleware` retrieves relevant memories before each model call and injects them into the system prompt inside a `<memory>` block
5. **Tool access** — The `memory` tool lets the model explicitly search, add, list, forget, and consolidate memories

---

## Skills System

Skills are markdown files that teach the agent domain-specific workflows. Each skill lives in `skills/<name>/SKILL.md` with optional YAML frontmatter.

### Loading

`SkillLoader` reads skills from disk, parses frontmatter (via `gray-matter`), and caches results. Skills are pre-loaded at startup.

### Injection

`createSkillMiddleware()` injects a `<skill_system>` block into the system prompt that:
- Lists all available skills with their names and descriptions as a JSON array
- Tells the model it can read the full skill content by calling `text_editor` on the skill file
- Detects when the user mentions a skill name and triggers auto-injection

This progressive loading pattern keeps the system prompt small by not loading every skill's full content upfront — the model requests what it needs.

---

## Todo System

The agent maintains a task list throughout conversation turns:

```typescript
interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}
```

- **`todo_write` tool** — `merge=true` updates by ID (add/change/remove), `merge=false` replaces all
- **`beforeModel` middleware** — increments step counters, injects reminders every 10 steps, prompts when all tasks are complete
- **State persistence** — stored in `AgentContext.metadata.todo`, synced through `ToolContext.sink.updateTodos()`

---

## Session System

Conversations can be saved, loaded, and resumed:

- **`SessionStore`** — persists messages as JSONL and metadata as JSON in `~/.my-agent/sessions/`
- **Auto-save** — an `afterAgentRun` hook saves the session after each agent run
- **Session commands** — `/sessions list`, `/sessions save <name>`, `/sessions load <name>`, `/sessions delete <name>` (TUI only)

---

## Terminal UI (TUI)

The TUI is built with [Ink](https://github.com/vadimdemedes/ink) (React for terminals) and uses `use-context-selector` for fine-grained state subscriptions.

### Component Tree

```
App
 ├─ Header          (agent name, model, status)
 ├─ ScrollView      (message list)
 │   ├─ ChatMessage[]    (user/assistant/tool messages, markdown rendering)
 │   ├─ StreamingMessage (current LLM output during streaming)
 │   └─ TodoPanel        (active task list)
 ├─ AskUserQuestionPrompt  (modal for multi-choice questions)
 ├─ StreamingIndicator     (animated dots during streaming)
 ├─ InputBox               (prompt input with autocomplete)
 │   ├─ CommandList        (slash-command dropdown)
 │   └─ HighlightedInput   (cursor-position-highlighted text)
 └─ Footer                 (token bar, usage stats)
```

### Performance Design

The TUI was tuned to prevent freezing during tool execution. Key techniques:

- **Scalar selectors** — `ToolCallMessage` subscribes to individual tool state fields (pending, focused, expanded, result) rather than the entire message list, so only the specific tool that changed re-renders
- **`React.memo` with custom comparator** — `ChatMessage` skips re-render when its specific message content hasn't changed
- **`useDeferredValue`** — the message list is deferred so the Footer and InputBox stay responsive even during large renders
- **Memoized formatting** — `smartSummarize()`, `formatToolResult()`, and `formatToolCallTitle()` results are cached with `useMemo`
- **Single-atomic dispatch** — tool results update all state fields in one reducer action instead of two, eliminating an intermediate render cycle

### State Flow

The `AgentLoopProvider` consumes the agent's async generator stream and dispatches actions to the `agentUIReducer`. Each event type maps to one reducer action:

```
text_delta        → TEXT_DELTA_BATCH    (batched via queueMicrotask for smooth rendering)
tool_call_start   → TOOL_START          (tool shows spinner)
tool_call_result  → TOOL_RESULT         (result displayed, messages updated atomically)
turn_complete     → TURN_COMPLETE       (usage accumulated)
agent_done        → LOOP_COMPLETE       (streaming stops, final state)
sub_agent_start   → SUB_AGENT_START     (sub-agent card appears)
sub_agent_done    → SUB_AGENT_DONE      (summary shown)
```

---

## Data Flow

A complete turn through the system:

```
User types "read src/agent/Agent.ts and explain the loop" → InputBox
  │
  ▼
AgentLoopProvider.onSubmit()
  │
  ▼
agent.runAgentLoop({ role: "user", content: "..." })
  │
  ├─ Phase 1: Setup
  │   ├─ contextManager.addMessage(userMessage)
  │   └─ beforeAgentRun hooks (skills preload)
  │
  ├─ Phase 2: LLM Turn 1
  │   ├─ beforeCompress → compressIfNeeded (skip, under threshold)
  │   ├─ beforeModel hooks (inject skill list, memory, todo reminders)
  │   ├─ provider.stream() → yields text_delta events
  │   │   └─ TUI dispatches TEXT_DELTA_BATCH → renders streaming text
  │   ├─ afterModel / beforeAddResponse hooks
  │   ├─ contextManager.addMessage(assistantMsg with tool_calls)
  │   └─ returns { done: false, toolCalls: [read(Agent.ts)] }
  │
  ├─ Phase 3: Tool Execution
  │   ├─ Budget guard: checkBatchBudget → proceed
  │   ├─ ToolDispatcher.dispatch()
  │   │   ├─ yield tool_call_start → TUI shows spinner
  │   │   ├─ PermissionMiddleware → ReadCacheMiddleware → tool.execute()
  │   │   │   └─ ReadTool reads file, returns content
  │   │   └─ yield tool_call_result → TUI shows tool result
  │   └─ contextManager.addMessage(toolResult)
  │
  ├─ Phase 2: LLM Turn 2
  │   └─ Model sees tool result, responds without tool calls → done: true
  │
  └─ Phase 4: Teardown
      ├─ afterAgentRun hooks (memory extracts key info, session auto-saves)
      └─ yields agent_done → TUI dispatches LOOP_COMPLETE
```

---

## Trace System

The Trace System (Phase 1) records agent loop execution for self-evolution. It captures every turn, tool call, LLM response, token usage, and error — persisting each run as incremental NDJSON in `~/.my-agent/traces/`.

### Architecture

```
src/trace/
  types.ts              # TraceRun, TraceTurn, TraceSummary, NudgeResult, NudgeState
  trace-buffer.ts       # Per-run accumulator, stored in AgentContext.metadata._traceBuffer
  store.ts              # TraceStore — NDJSON append + finalize + retention (max 50/session)
  redactor.ts           # DefaultRedactor — secret pattern masking + path truncation
  tool-middleware.ts    # TraceToolMiddleware — records tool execution (name, success, timing)
  agent-middleware.ts   # TraceAgentMiddleware — 3 hooks
  nudge-engine.ts       # 3-signal trigger + fingerprint dedup
  index.ts              # createTraceMiddleware() factory
```

### Hooks Used

| Hook | Action |
|------|--------|
| `beforeAgentRun` | Create TraceBuffer per-run, store in `metadata._traceBuffer` |
| `beforeAddResponse` | Record LLM response (tools called, usage, redacted text) |
| `afterAgentRun` | `setImmediate` → finalize trace + nudge check |

### Nudge Engine — Three Signals

| Signal | Condition | Rationale |
|--------|-----------|-----------|
| Error burst | `errors >= 2` AND `errors/turns >= 0.3` | Capture failure patterns while context is fresh |
| Complex task | `turns >= 5` AND `errors = 0` | Successful multi-step tasks are skill candidates |
| Periodic | Accumulated turns >= `reviewInterval` (default 10) | Catch-all for long sessions |

Fingerprint dedup prevents the same error pattern from triggering review twice. Minimum 5-minute interval between reviews.

### Data Flow

```
beforeAgentRun → beforeAddResponse → TraceToolMiddleware → afterAgentRun
     │                  │                    │                    │
  new buffer       recordModelResp    recordToolExec    setImmediate:
  → ctx.metadata   (redacted)         (timing + error)  finalize + nudge
```

---

## Self-Evolution System

The Evolution System (Phases 2+3) closes the loop: trace data → pattern detection → background review → auto-generated skills → quality measurement → feedback.

### Architecture

```
src/evolution/
  types.ts                  # ReviewConfig, SkillStats, SkillStatus, EvolutionCallback
  prompt-templates.ts       # buildReviewPrompt() — 3 templates with skill-creator methodology
  review-agent.ts           # forkReviewAgent() — Agent fork + system prompt builder
  review-tools.ts           # CreateReviewSkillTool — writes SKILL.md with dedup
  skill-analyzer.ts         # Tier 2 LLM analysis: forkSkillAnalysis, buildAnalysisPrompt
  effectiveness-tracker.ts  # Mechanical scoring (Tier 1) + status.json I/O + auto-accept
  index.ts                  # initEvolution() factory
```

### Phase 2: Background Review

When a NudgeResult fires, a lightweight Review Agent analyzes the trace and produces skills:

1. **Trigger mapping**: `error_burst`/`memory_review`/`combined_review` → review prompt template
2. **Existing skill check**: lists `~/.my-agent/skills/auto/` for dedup guidance
3. **Review Agent fork**: independent Agent, cheap model, max 6 turns, single tool (`create_review_skill`)
4. **Value scoring**: 1-5 scale built into prompt; score < 3 → "Nothing to save"
5. **Skill output**: writes `SKILL.md` with YAML frontmatter + body + pitfalls to `~/.my-agent/skills/auto/{name}/`

### Phase 3: Quality Assurance

**Tier 1 — Mechanical Scoring**: Every run with activated auto skills updates `{skill}.status.json` with success rate.

**Tier 2 — LLM Deep Analysis**: When success rate < 0.5 after >= 3 runs, a Tier 2 agent analyzes the skill's effectiveness:
- Verdicts: `keep`, `fix` (with suggestion), `delete`
- `fix` verdicts auto-generate eval cases for prompt optimization
- Results shown in TUI notifications

**Approval Queue**: `/review` slash command (list/view/keep/delete/edit) + keyboard shortcuts (k/d) in notification cards.

**Hot-Reload**: `SkillLoader.checkAutoSkills()` checks `~/.my-agent/skills/auto/` mtime in `beforeAgentRun` — zero overhead, no file watcher.

**Feedback Loop**: Tier 2 `fix` verdicts → eval cases in `review-prompt-evals-feedback.json` → user runs prompt optimization via skill-creator `run_loop.py`.

### Skill Source Priority

```
skills/                          # Project skills (user-created) — highest priority
~/.my-agent/skills/auto/         # Auto-generated by Review Agent — overridden by project
```

`SkillLoader` scans both sources. Same-name project skill wins.

---

## Architecture Rules

The [Architecture Constitution](./ARCHITECTURE-CONSTITUTION.md) defines non-negotiable rules. Key ones:

1. **Single assembly point** — `createAgentRuntime()` is the only way to wire the application. CLI scripts in `bin/` must not instantiate core classes directly.

2. **No `any` without justification** — unsafe type casts need an explanatory comment. New `any` types block CI.

3. **No new `syncTodoFromContext` call sites** — todo sync is restricted to existing integration points.

4. **`debugLog` over `console.log`** — all debugging output uses the structured logger.

5. **File size limits** — files > 400 lines and functions > 80 lines need explicit justification.

6. **Public API testing** — new public methods require unit tests.

7. **Frozen hook surface** — the six agent hooks and dispatcher methods are the only extension points. New hooks require an RFC.

---

## Further Reading

- [ARCHITECTURE-CONSTITUTION.md](./ARCHITECTURE-CONSTITUTION.md) — binding code rules
- [CLAUDE.md](./CLAUDE.md) — development commands and file map
- [README.md](./README.md) — project overview and getting started
