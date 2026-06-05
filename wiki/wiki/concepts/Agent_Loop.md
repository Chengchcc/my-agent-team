---
title: "Agent Loop"
type: concept
created: 2026-06-05
updated: 2026-06-05
sources:
  - raw/articles/00-overview.md
  - raw/articles/02-framework.md
tags: [runtime, core, loop]
---

# Agent Loop

The core execution cycle. A while-loop that runs until the model stops calling tools or `maxSteps` is reached.

```mermaid
sequenceDiagram
  participant C as Caller
  participant R as run()
  participant M as ChatModel
  participant T as Tool

  C->>R: run(model, tools, messages)
  loop until no tool_use or maxSteps
    R->>M: stream(messages)
    M-->>R: assistant chunks
    R->>R: push assistant to messages
    alt has tool_use
      R->>T: execute(input)
      T-->>R: result
      R->>R: push tool_result to messages
    end
  end
  R-->>C: done
```

## Key properties

- **State belongs to caller**: `messages` array is caller-owned; `run()` appends in-place
- **Serial tool execution**: M1 executes tools one at a time, not parallel
- **Error handling**: Model errors propagate up. Tool errors become `is_error: true` tool_result blocks, letting the LLM recover from context
- **Streaming**: `AsyncIterable<AIMessageChunk>` carries delta through the entire stack

## L2 vs L3

L2 `run()` is the bare generator — caller provides everything each time. L3 `Agent.run()` wraps it with Thread, Plugin hooks, Checkpointer save points, and ContextManager shaping.
