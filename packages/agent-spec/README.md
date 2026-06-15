# @my-agent-team/agent-spec

> **Layer:** L1 Protocols (wire contract) &nbsp;|&nbsp; **Dependencies:** `zod` only

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L6  Surfaces     web / cli / lark-bot    │
│ L5  Backend ──────────┐                  │
├────────────────────────┼─────────────────┤
│         wire contract  │                  │
│         ┌──────────────▼──────────────┐  │
│         │       agent-spec            │  │
│         │  AgentSpecV2 (zod schema)  │  │
│         └──────────────┬──────────────┘  │
│                        │                  │
│ Runner Daemon ─────────┘                  │
└──────────────────────────────────────────┘
```

## What problem it solves

Backend and runner daemon are separate processes communicating over Unix sockets. They must agree on what a "start run" payload looks like. This package defines that contract as Zod schemas — both sides validate against the same schema, catching mismatches at the boundary.

## Schema versions

```
AgentSpecV1 (deprecated)
  Flat shape: schemaVersion, workspace, threadId, model, apiKey, ...

AgentSpecV2 (current)
  Discriminated union on "mode":
    ├── "run"      → AgentSpecV2Run
    ├── "resume"   → AgentSpecV2Resume
    └── "reflect"  → AgentSpecV2Reflect
```

## Key exports

| Export | What | Why |
|--------|------|-----|
| `AgentSpecV2` | `z.discriminatedUnion("mode", [...])` | Validates all incoming payloads |
| `AgentSpecV2Run` | Run-mode payload | New agent run with input |
| `AgentSpecV2Resume` | Resume-mode payload | Human has approved/denied an interrupt |
| `AgentSpecV2Reflect` | Reflect-mode payload | Post-run reflection pass |
| `AgentSpec` | `z.infer<typeof AgentSpecV2>` | Inferred TypeScript type |
| `CURRENT_SCHEMA_VERSION` | `"1"` | Version constant |

## Usage (backend side)

```ts
import { AgentSpecV2 } from "@my-agent-team/agent-spec";

const payload = AgentSpecV2.parse({
  mode: "run",
  agentId: "agent-42",
  runId: "run-abc",
  threadId: "thread-xyz",
  model: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
  // ...
});

transport.send({ type: "start", spec: payload });
```

## Usage (runner side)

```ts
import { AgentSpecV2 } from "@my-agent-team/agent-spec";

transport.onMessage((msg) => {
  if (msg.type === "start") {
    const spec = AgentSpecV2.parse(msg.spec); // validates at boundary
    // create agent, run...
  }
});
```

## Dependencies

```
agent-spec (this package)
  ↑ depends on: zod
  ↑ depended on by: apps/backend, runner-daemon
```
