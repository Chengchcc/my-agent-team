# @my-agent-team/framework

> **Layer:** L3 Framework &nbsp;|&nbsp; **Depends on:** `@my-agent-team/core`

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L6  Surfaces     web / cli / lark-bot    │
│ L5  Backend      HTTP/SSE server         │
│ L4  Harness      opinionated agent       │
├──────────────────────────────────────────┤
│ L3  Framework    plugins + composition ◄─ HERE
│ L2  Runtime      run() loop              │
│ L1  Protocols    Message/Tool/ChatModel  │
└──────────────────────────────────────────┘
```

## What problem it solves

Core gives you `run()`, but wiring up context windows, persistence, plugin hooks, and human-in-the-loop is boilerplate. Framework provides `createAgent()` — one call that composes model + tools + plugins + checkpointer + context manager into a stateful agent with `.run()` / `.resume()`.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  createAgent(config)                 │
│                                                     │
│  config.model ─────────┐                            │
│  config.tools ─────────┤                            │
│  config.plugins ───────┤   ┌──────────────────┐     │
│  config.checkpointer ──┼──→│     Agent        │     │
│  config.contextManager ─┘  │  .run(input)     │     │
│                            │  .resume(cmd)    │     │
│                            └──────────────────┘     │
└─────────────────────────────────────────────────────┘
```

## Four plugin hook points

All hooks fire in plugin registration order:

```
messages → [beforeModel] → model.stream()
                                │
       ┌────────────────────────┘
       ▼
  [afterModel] ──→ tool calls?
       │                │
       │        ┌───────▼───────┐
       │        │ [beforeTool]  │
       │        │ execute()     │
       │        │ [afterTool]   │
       │        └───────┬───────┘
       │                │
       ▼                ▼
     loop back to [beforeModel] or stop
```

## Context manager pipeline

```
messages → [slidingWindow] → [summarizing] → [tokenBudget] → model
```

Each context manager's `shape()` receives the output of the previous one. Built-in options:

| Manager | What it does |
|---------|-------------|
| `passthrough` | No-op, passes messages through |
| `slidingWindow` | Keeps last N messages |
| `summarizing` | Summarizes old messages to keep context small |
| `tokenBudget` | Truncates to a token budget |
| `toolResultTruncator` | Truncates large tool results |

## Checkpointer + Interrupt

```
Tool.execute() ──→ throw InterruptSignal
                         │
                  Agent pauses, saves interrupt state
                         │
                  Human approves / denies
                         │
                  agent.resume({ approved: true/false })
```

## Key exports

| Export | What | Why |
|--------|------|-----|
| `createAgent()` | Compose model+tools+plugins+checkpointer+ctxMgr → Agent | One-call agent setup |
| `definePlugin()` | `{ name, tools, hooks }` → Plugin | Standard plugin contract |
| `pipeContextManagers()` | `(...managers) → ContextManager` | Chain window-shaping logic |
| `InterruptSignal` | Error class | Throw from tool to pause for human approval |
| `fileCheckpointer()` | Filesystem persistence | Dev/single-tenant |
| `sqliteCheckpointer()` | SQLite persistence | Production |
| `inMemoryCheckpointer()` | No persistence | Tests |

## Usage

```ts
import { createAgent, definePlugin, pipeContextManagers,
         slidingWindowContextManager, toolResultTruncator } from "@my-agent-team/framework";

const agent = createAgent({
  model: new AnthropicChatModel({ apiKey: "..." }),
  tools: [bashTool, readTool],
  plugins: [fsMemoryPlugin({ ws: "/workspace" })],
  checkpointer: sqliteCheckpointer({ dbPath: "state.db" }),
  contextManager: pipeContextManagers(
    slidingWindowContextManager({ maxMessages: 50 }),
    toolResultTruncator({ maxChars: 8000 }),
  ),
});

for await (const event of agent.run("Deploy the app")) {
  // AgentEvent stream: message | tool_call | tool_result | interrupt | ...
}
```

## Dependencies

```
framework (this package)
  ↑ depends on: core
  ↑ depended on by: harness, event-log, runner-protocol,
                     plugin-fs-memory, plugin-progressive-skill,
                     plugin-task-guard
```
