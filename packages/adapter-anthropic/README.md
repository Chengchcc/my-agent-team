# @my-agent-team/adapter-anthropic

> **Layer:** Adapter (provider integration) &nbsp;|&nbsp; **Depends on:** `@my-agent-team/core`

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L6  Surfaces     web / cli / lark-bot    │
│ L5  Backend      HTTP/SSE server         │
│ L4  Harness      opinionated agent       │
│ L3  Framework    plugins + composition   │
│ L2  Runtime      run() loop              │
│ L1  Protocols    Message/Tool/ChatModel  │
├──────────────────────────────────────────┤
│ Adapter          Anthropic ◄── HERE       │
└──────────────────────────────────────────┘
```

## What problem it solves

Core defines `ChatModel` as an interface with zero LLM dependency. This package implements it for the Anthropic API, translating between core types (`Message`, `Tool`, `ContentBlock`) and the Anthropic SDK format. It's the **only place** in the entire codebase that imports `@anthropic-ai/sdk`.

## Translation flow

```
┌─────────────────────┐         ┌─────────────────────┐
│   Core types         │         │   Anthropic SDK      │
│                      │         │                      │
│   Message ───────────┼──map───→│   MessageParam       │
│   Tool[] ────────────┼──map───→│   Tool[]             │
│   ChatModelOptions ──┼──map───→│   MessageCreateParams│
│                      │         │                      │
│   AIMessageChunk ◄───┼──map───│   RawMessageStreamEvt│
│   (TextBlock,        │         │   (text_delta,       │
│    ToolUseBlock)     │         │    content_block_*)   │
└─────────────────────┘         └─────────────────────┘
```

## Key exports

| Export | What | Why |
|--------|------|-----|
| `AnthropicChatModel` | `class implements ChatModel` | Drop-in for any code expecting `ChatModel` |
| `toAnthropicTools(coreTools)` | `Tool[] → AnthropicTool[]` | Converts core tool defs to Anthropic's format |
| `AnthropicChatModelConfig` | `{ apiKey, model, baseUrl?, ... }` | Configuration |

## Usage

```ts
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import { createAgent } from "@my-agent-team/framework";

const model = new AnthropicChatModel({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-6",
});

const agent = createAgent({ model, tools: [...] });
```

## Dependencies

```
adapter-anthropic (this package)
  ↑ depends on: core
  ↑ depended on by: runner-daemon, apps/backend, apps/cli
  ↑ substituted by: test-helpers/echoModel() in tests
```
