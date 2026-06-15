# @my-agent-team/runner-protocol

> **Layer:** Wire / Transport &nbsp;|&nbsp; **Depends on:** core, framework, runtime-observability

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L5  Backend ──────────┐                  │
│                       │                  │
│                ┌──────▼──────┐           │
│                │runner-protocol│◄── HERE  │
│                │NDJSON messages│          │
│                │Unix socket    │          │
│                └──────┬──────┘           │
│                       │                  │
│ Runner Daemon ────────┘                  │
└──────────────────────────────────────────┘
```

## What problem it solves

Backend and runner daemon need a shared language and transport. This package defines every message type (both directions) as a discriminated union, provides NDJSON framing, and implements both Unix socket transport (production) and in-memory transport pairs (testing).

## Message types

```
HostToRunner (backend → daemon)
├── start         { spec: AgentSpecV2, preloadedMessages?, surfaceContext? }
├── abort         { runId }
└── run_finalized { runId }

RunnerToHost (daemon → backend)
├── run_started   { runId }
├── event         { runId, event: AgentEvent }
├── delta         { runId, delta: AgentDelta }
├── heartbeat     { activeRunIds[] }
├── run_done      { runId, summary }
└── daemon_health { agentId, uptime, activeRuns }
```

## Transport options

| Transport | Use case |
|-----------|----------|
| `createSocketServer(path)` | Production — Unix socket, backend listens |
| `createSocketClient(path)` | Production — Unix socket, daemon connects |
| `createMemoryTransportPair()` | Testing — deterministic, in-process |

## NDJSON framing

```
{"type":"start","spec":{...}}\n
{"type":"event","runId":"abc","event":{...}}\n
{"type":"delta","runId":"abc","delta":{...}}\n
```

Each message is one JSON line. `createFramer()` handles buffering partial lines and emitting complete messages.

## Key exports

| Export | What | Why |
|--------|------|-----|
| `HostToRunner` | Discriminated union | Backend → daemon messages |
| `RunnerToHost` | Discriminated union | Daemon → backend messages |
| `ProtocolMessage` | `HostToRunner \| RunnerToHost` | Full protocol |
| `RunnerTransport` | `{ send, onMessage, close }` | Transport interface |
| `createSocketClient(path)` | `→ RunnerTransport` | Unix socket client |
| `createSocketServer(path)` | `→ RunnerTransport` | Unix socket server |
| `createMemoryTransportPair()` | `→ [Host, Runner]` | In-memory pair for tests |
| `createFramer()` | `→ { push, onMessage }` | NDJSON buffering |
| `encode(msg)` | `→ string` | JSON line with trace context |

## Usage (backend side)

```ts
import { createSocketServer, type HostToRunner, type RunnerToHost } from "@my-agent-team/runner-protocol";

const transport = createSocketServer("/var/run/agent-42.sock");

transport.onMessage((msg: RunnerToHost) => {
  switch (msg.type) {
    case "event":     /* stream to SSE */ break;
    case "run_done":  /* finalize */ break;
    case "heartbeat": /* update health */ break;
  }
});

transport.send({ type: "start", spec: agentSpec });
```

## Dependencies

```
runner-protocol (this package)
  ↑ depends on: core, framework, runtime-observability
  ↑ depended on by: runner-daemon, apps/backend
```
