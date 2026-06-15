# @my-agent-team/plugin-task-guard

> **Layer:** L3 Plugin &nbsp;|&nbsp; **Depends on:** core, framework

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L4  Harness ────┐                        │
│                 │ default plugin         │
│          ┌──────▼──────────────┐         │
│          │ plugin-task-guard    │ ◄─ HERE │
│          │ todo plan + stop     │         │
│          │ validation           │         │
│          └─────────────────────┘         │
│ L3  Framework    definePlugin()          │
└──────────────────────────────────────────┘
```

## What problem it solves

Agents tend to stop too early — they declare "done" before all tasks are complete, or when tool errors are unresolved. This plugin acts as a **guard** at the stop boundary:

1. **Plans** — generates a structured todo list before execution
2. **Tracks** — injects progress into the system prompt every turn
3. **Validates** — double-checks stop decisions (both in the same model call and with a separate "cold" model call)

## Stop validation pipeline

```
Agent wants to stop
        │
        ▼
┌──────────────────┐
│ Hot verification │  ← Same model call: "Are all todos done?"
│ Check todo status│     Fast, inline check
└──────┬───────────┘
       │ ✓ passed
       ▼
┌──────────────────┐
│ Cold verification│  ← Separate model call: independent confirmation
│ Fresh model ask: │     "Is this work really complete?"
│ "Is work done?"  │
└──────┬───────────┘
       │ ✓ passed
       ▼
┌──────────────────┐
│ unresolvedTool   │  ← Always active: are there tool errors pending?
│ Errors check     │
└──────┬───────────┘
       │ ✓ passed
       ▼
   Allow stop
```

## Key exports

| Export | What | Why |
|--------|------|-----|
| `taskGuardPlugin(opts)` | `→ Plugin` | Full task guard with planning + validation |
| `unresolvedToolErrors` | `StopValidator` | Built-in: blocks stop if tool errors exist |
| `TaskGuardOptions` | Type | Plugin configuration |
| `Todo` | Type | `{ id, title, status }` |
| `TodoStatus` | `"pending" \| "in_progress" \| "completed"` | Status enum |
| `StopValidator` | Type | `(ctx) → StopDecision` |

## Usage

```ts
import { taskGuardPlugin, unresolvedToolErrors } from "@my-agent-team/plugin-task-guard";
import { createAgent } from "@my-agent-team/framework";

const agent = createAgent({
  model: "...",
  plugins: [
    taskGuardPlugin({
      validators: [unresolvedToolErrors],
      enableColdVerification: true,
    }),
  ],
});
```

## Dependencies

```
plugin-task-guard (this package)
  ↑ depends on: core, framework
  ↑ depended on by: harness (as default plugin)
```
