# @my-agent-team/event-log

> **Layer:** Infrastructure &nbsp;|&nbsp; **Depends on:** `@my-agent-team/framework`

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L5  Backend ────┐                        │
│                 │                        │
│          ┌──────▼──────┐                 │
│          │  event-log   │  ◄── HERE      │
│          │  append only │                │
│          │  subscribe   │                │
│          └──────┬──────┘                 │
│                 │                        │
│          SSE stream to clients           │
└──────────────────────────────────────────┘
```

## What problem it solves

Agent runs produce a stream of events (messages, tool calls, tool results, interrupts). Clients (CLI, web) need to see these in real time. This package provides an append-only event store with **subscribe semantics** — clients poll for new events after their last seen sequence number, and the store pushes new events as they're appended.

## Data flow

```
Runner Daemon                Backend                   Client
─────────────               ─────────                 ──────
agent.run()
  → event1 ────→ append() ──→ seq=1
  → event2 ────→ append() ──→ seq=2 ──→ SSE: event1
  → event3 ────→ append() ──→ seq=3 ──→ SSE: event2
                                         SSE: event3
                                               │
                                        subscribe({ after: 0 })
                                        ← event1, event2, event3
```

## Storage backends

| Backend | Use case |
|---------|----------|
| `sqliteEventLog({ dbPath })` | Production — durable, survives restarts |
| `inMemoryEventLog()` | Tests — fast, no filesystem |

## Key exports

| Export | What | Why |
|--------|------|-----|
| `EventLog` | `EventSink & EventSource` | Combined read+write interface |
| `EventSink` | `append(threadId, runId, event) → Promise<seq>` | Write side |
| `EventSource` | `read(query)` + `subscribe(query, opts, signal)` | Read + real-time tail |
| `sqliteEventLog()` | Factory | SQLite-backed durable store |
| `inMemoryEventLog()` | Factory | In-memory store for tests |
| `EventRecord` | `{ seq, threadId, runId, event }` | Stored event shape |
| `EVENT_LOG_MIGRATIONS` | SQL DDL | Schema migrations |

## Usage

```ts
import { sqliteEventLog } from "@my-agent-team/event-log";

const log = sqliteEventLog({ dbPath: "events.db" });

// Write side (backend receives from runner)
const seq = await log.append("thread-1", "run-abc", {
  type: "tool_call",
  toolName: "bash",
  input: { command: "ls" },
});

// Read side (SSE streaming to client)
for await (const record of log.subscribe(
  { threadId: "thread-1" },
  { after: lastSeenSeq },
  abortSignal,
)) {
  res.write(`data: ${JSON.stringify(record)}\n\n`);
}
```

## Dependencies

```
event-log (this package)
  ↑ depends on: framework (for AgentEvent type)
  ↑ depended on by: apps/backend
```
