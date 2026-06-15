# Packages

## Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  L6  Surfaces         web        cli       lark-bot          │
│                        │          │          │               │
│                        │   HTTP   │   HTTP   │  HTTP         │
│                        ▼          ▼          ▼               │
│  L5  Backend    ┌──────────────────────────────┐             │
│                 │         apps/backend          │             │
│                 │  agent CRUD, runs, SSE,       │             │
│                 │  runner pool, conversations   │             │
│                 └──────┬───────────────────────┘             │
│                        │ Unix socket (runner-protocol)       │
│                 ┌──────▼───────────────────────┐             │
│                 │     runner-daemon (× N)       │             │
│                 │  per-agent sandbox process    │             │
│                 └──────┬───────────────────────┘             │
│                        │                                     │
│  L4  Harness    ┌──────▼───────────────────────┐             │
│                 │          harness              │             │
│                 │  createGenericAgent()         │             │
│                 │  default plugins + tools      │             │
│                 └──────┬───────────────────────┘             │
│                        │                                     │
│  L3  Framework  ┌──────▼───────────────────────┐             │
│                 │         framework             │             │
│                 │  createAgent(), plugins,      │             │
│                 │  contextManager, checkpointer │             │
│                 └──────┬───────────────────────┘             │
│                        │                                     │
│  L2  Runtime    ┌──────▼───────────────────────┐             │
│                 │           core                │             │
│  L1  Protocols  │  run(), Message, ChatModel,   │             │
│                 │  Tool, ContentBlock           │             │
│                 └──────────────────────────────┘             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Dependency graph

```
                        ┌─────────────────┐
                        │      core       │  (zero deps)
                        └────────┬────────┘
                                 │
             ┌───────────────────┼───────────────────┐
             │                   │                   │
       ┌─────▼─────┐     ┌──────▼──────┐     ┌──────▼──────┐
       │ framework │     │tools-common │     │   adapter-  │
       └─────┬─────┘     │             │     │  anthropic  │
             │           └──────┬──────┘     └──────┬──────┘
             │                  │                   │
    ┌────────┼────────┐        │                   │
    │        │        │        │                   │
┌───▼──┐ ┌──▼───┐ ┌──▼───┐    │                   │
│plugin│ │plugin│ │plugin│    │                   │
│-fs-  │ │-prog-│ │-task-│    │                   │
│memory│ │skill │ │guard │    │                   │
└───┬──┘ └──┬───┘ └──┬───┘    │                   │
    │       │        │        │                   │
    └───┬───┴────────┘        │                   │
        │                     │                   │
   ┌────▼─────────────────────▼──────┐     ┌──────▼──────┐
   │            harness              │     │  runner-    │
   │  (wires everything together)    │     │  daemon     │
   └────────────────┬────────────────┘     └──────┬──────┘
                    │                              │
                    │                     ┌────────▼────────┐
                    │                     │  runner-protocol │
                    │                     │  (NDJSON/socket) │
                    │                     └────────┬────────┘
                    │                              │
            ┌───────▼──────┐              ┌────────▼────────┐
            │   apps/cli   │              │  apps/backend    │
            └──────────────┘              └────────┬────────┘
                                                   │
                              ┌────────────────────┼──────────────┐
                              │                    │              │
                        ┌─────▼─────┐     ┌───────▼──────┐  ┌────▼─────┐
                        │ agent-spec│     │ conversation │  │event-log │
                        │ (zod)     │     │   (zod)      │  │(SQLite)  │
                        └───────────┘     └──────────────┘  └──────────┘
```

## Package list by layer

### L1 — Protocols (zero runtime deps, only `zod`)

| Package | Role |
|---------|------|
| [`core`](./core/) | `Message`, `ChatModel`, `Tool`, `ContentBlock` — the universal type contracts |
| [`agent-spec`](./agent-spec/) | `AgentSpecV2` — wire schema between backend and runner daemon |
| [`conversation`](./conversation/) | `Conversation`, `Member`, `LedgerEntry` — multi-agent conversation domain |

### L2 — Runtime

| Package | Role |
|---------|------|
| [`core`](./core/) | `run()` — the async generator agent loop (same package as L1) |

### L3 — Framework + Plugins

| Package | Role |
|---------|------|
| [`framework`](./framework/) | `createAgent()` — composition, plugins, context managers, checkpointer, interrupt |
| [`plugin-fs-memory`](./plugin-fs-memory/) | Persistent file-backed memory plugin |
| [`plugin-progressive-skill`](./plugin-progressive-skill/) | SKILL.md progressive loading plugin |
| [`plugin-task-guard`](./plugin-task-guard/) | Todo planning + stop validation plugin |

### L4 — Harness

| Package | Role |
|---------|------|
| [`harness`](./harness/) | `createGenericAgent()` — opinionated agent with all defaults wired |

### Infrastructure

| Package | Role |
|---------|------|
| [`agent-fs`](./agent-fs/) | Capability-based virtual filesystem for agent sandboxing |
| [`event-log`](./event-log/) | Durable append-only event store with subscribe/tail (SQLite) |
| [`runner-daemon`](./runner-daemon/) | Long-lived per-agent sandbox process |
| [`runner-protocol`](./runner-protocol/) | NDJSON message types + Unix socket transport |
| [`runtime-observability`](./runtime-observability/) | OpenTelemetry tracing + metrics + redaction |

### Tools

| Package | Role |
|---------|------|
| [`tools-common`](./tools-common/) | Standard tool implementations: bash, read/write/edit, grep, glob, web, memory |

### Adapters

| Package | Role |
|---------|------|
| [`adapter-anthropic`](./adapter-anthropic/) | `AnthropicChatModel` — the only LLM SDK import in the codebase |

### Testing

| Package | Role |
|---------|------|
| [`test-helpers`](./test-helpers/) | `echoModel()` — deterministic ChatModel test double |

## How to navigate

**Starting from scratch?** Read these in order:
1. [`core`](./core/) — understand the type contracts and agent loop
2. [`framework`](./framework/) — understand plugins, context managers, and composition
3. [`harness`](./harness/) — see how everything wires together

**Adding a plugin?** Read:
1. [`framework`](./framework/) — the `definePlugin()` contract
2. Any existing plugin ([`plugin-fs-memory`](./plugin-fs-memory/), [`plugin-progressive-skill`](./plugin-progressive-skill/), [`plugin-task-guard`](./plugin-task-guard/)) — copy the pattern

**Adding a provider?** Read:
1. [`core`](./core/) — the `ChatModel` interface
2. [`adapter-anthropic`](./adapter-anthropic/) — copy the adapter pattern

**Working on the backend?** Read:
1. [`agent-spec`](./agent-spec/) — the wire payload schema
2. [`runner-protocol`](./runner-protocol/) — the message types and transport
3. [`runner-daemon`](./runner-daemon/) — what happens on the other end of the socket
4. [`event-log`](./event-log/) — how events are persisted and streamed
