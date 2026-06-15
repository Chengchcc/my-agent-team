# @my-agent-team/test-helpers

> **Layer:** Testing &nbsp;|&nbsp; **Depends on:** `@my-agent-team/core`

## Position in the stack

```
┌──────────────────────────────────────────┐
│ Every package's test suite               │
│           │                              │
│    ┌──────▼──────┐                       │
│    │ test-helpers │  ◄── HERE            │
│    │ echoModel() │                       │
│    └──────┬──────┘                       │
│           │                              │
│ substitutes ChatModel in tests           │
└──────────────────────────────────────────┘
```

## What problem it solves

Testing agent behavior with real LLM calls is slow, expensive, and non-deterministic. `echoModel()` implements `ChatModel` with a **script** — you define exactly what the model should return on each turn, and the agent loop runs deterministically against those responses. This is the primary testing strategy across the entire repo.

## How it works

```
┌──────────────────────────────────────┐
│ EchoScript = [                       │
│   [chunk1, chunk2, ...],  // turn 1  │
│   [chunk3, chunk4, ...],  // turn 2  │
│   ...                                │
│ ]                                    │
│                                      │
│ echoModel(script).stream(messages)   │
│   → yields turn1 chunks              │
│   → then turn2 chunks                │
│   → then ...                         │
└──────────────────────────────────────┘
```

## Key exports

| Export | What | Why |
|--------|------|-----|
| `echoModel(script)` | `→ ChatModel` | Deterministic test double |
| `EchoScript` | `AIMessageChunk[][]` | Script type — one array per model turn |

## Usage

```ts
import { echoModel } from "@my-agent-team/test-helpers";
import { run, collectStream } from "@my-agent-team/core";

const model = echoModel([
  // Turn 1: model outputs a tool call
  [
    { type: "tool_use", id: "1", name: "bash", input: { command: "ls" } },
  ],
  // Turn 2: after tool result, model outputs text
  [
    { type: "text", text: "I ran ls and found 3 files." },
  ],
]);

const messages = [userMsg("List files")];
const result = await collectStream(run({ model, tools: [bashTool], messages }));

expect(result.at(-1)!.content).toContain("3 files");
```

## Dependencies

```
test-helpers (this package)
  ↑ depends on: core
  ↑ depended on by: (devDependency of every other package)
```
