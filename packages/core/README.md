# @my-agent-team/core

> **Layer:** L1 Protocols + L2 Runtime &nbsp;|&nbsp; **Dependencies:** zero

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L6  Surfaces     web / cli / lark-bot    │
│ L5  Backend      HTTP/SSE server         │
│ L4  Harness      opinionated agent       │
│ L3  Framework    plugins + composition   │
├──────────────────────────────────────────┤
│ L2  Runtime      run() loop  ◄── HERE    │
│ L1  Protocols    Message/Tool/ChatModel  │
└──────────────────────────────────────────┘
```

## What problem it solves

Every other package needs to agree on **what a message is**, **what a tool is**, and **how the agent loop works** — without pulling in an LLM SDK. Core defines these contracts and the `run()` async generator. Nothing else in the stack imports an LLM directly; they all import from here.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Message    │     │  ChatModel   │     │     Tool     │
│  role+content│     │  .stream()   │     │  execute()   │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                   ┌────────▼────────┐
                   │     run()       │
                   │  messages →     │
                   │  model.stream() │
                   │  → tool exec    │
                   │  → loop         │
                   └────────┬────────┘
                            │
                   ┌────────▼────────┐
                   │ AsyncIterable   │
                   │ <AIMessageChunk>│
                   └─────────────────┘
```

## Key exports

| Export | What | Why |
|--------|------|-----|
| `Message` | `{ role, content }` | The universal message shape — every layer passes these around |
| `ChatModel` | `stream(messages, opts) → AsyncIterable<AIMessageChunk>` | **The only integration point.** Swap implementations to switch LLM providers |
| `Tool` | `{ name, description, inputSchema, execute }` | Contract every tool must satisfy |
| `ContentBlock` | `TextBlock \| ToolUseBlock \| ToolResultBlock` | Structured content inside messages |
| `run()` | `async function*` | The agent loop: model → tools → model → … |
| `collectStream()` | utility | Buffer async chunks into complete Messages |

## Usage

```ts
import { run, type ChatModel, type Tool } from "@my-agent-team/core";

const model: ChatModel = new AnthropicChatModel({ apiKey: "..." });
const tools: Tool[] = [readTool, bashTool];

for await (const chunk of run({ model, tools, messages: [msg] })) {
  // stream chunks to UI
}
```

## Dependencies

```
core (this package)
  ↑ depends on: nothing
  ↑ depended on by: framework, tools-common, adapter-anthropic,
                     test-helpers, harness, runner-protocol,
                     plugin-fs-memory, plugin-progressive-skill,
                     plugin-task-guard
```
