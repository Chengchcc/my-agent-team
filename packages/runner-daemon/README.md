# @my-agent-team/runner-daemon

> **Layer:** Runner Infrastructure (L4-L5 bridge) &nbsp;|&nbsp; **Depends on:** harness, adapter-anthropic, agent-spec, core, framework, runner-protocol, agent-fs

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L5  Backend ──────────┐                  │
│                       │ Unix socket      │
│                ┌──────▼──────┐           │
│                │runner-daemon │ ◄── HERE  │
│                │per-agent     │           │
│                │long-lived    │           │
│                │sandbox       │           │
│                └──────┬──────┘           │
│                       │                  │
│ L4  Harness ──────────┘                  │
│     createGenericAgent()                 │
└──────────────────────────────────────────┘
```

## What problem it solves

Running every agent turn as a new process is expensive (cold start for model connections, plugin initialization, workspace setup). Runner daemon is a **long-lived process** — one per agent — that stays resident and handles multiple runs. Backend sends `start`/`abort`/`run_finalized` commands over a Unix socket; the daemon creates agents, runs them, and streams events back.

## Lifecycle

```
Backend                         Runner Daemon
───────                         ─────────────
spawn process ─────────────────→ starts, opens socket
                                  sends daemon_health

POST /runs ──→ start(spec) ────→ AgentSpecV2.parse(spec)
                                  createGenericAgent(spec)
                                  agent.run(input)
                                    ↓
                                  event stream ──→ event(delta)
                                                     event(delta)
                                  run completes
                                  run_done(summary)

POST /reflect ──→ start(reflect)→ reflection run
                                  run_done(reflection)

DELETE /runs ──→ abort ─────────→ agent.abort()

agent deleted ──→ run_finalized → cleanup, close transport
```

## Concurrency model

One daemon handles **multiple concurrent runs** for the same agent. Each run gets its own thread and checkpointer scope. Abort signals are sent via the transport and handled cooperatively.

## Key exports

| Export | What | Why |
|--------|------|-----|
| `RunnerDaemon` | Class | Manages full daemon lifecycle |
| `RunnerDaemonOptions` | Type | `{ transport, agentId, sharedRoot, privateRoot, stateRoot, modelFactory, ... }` |
| `bin.ts` | CLI | `my-agent-runner --agent-id <id> --socket <path> ...` |

## CLI entry

```bash
ANTHROPIC_API_KEY=sk-... my-agent-runner \
  --agent-id agent-42 \
  --socket /var/run/agent-42.sock \
  --shared-root /data/shared \
  --private-root /data/private/agent-42 \
  --state-root /data/state/agent-42
```

## Dependencies

```
runner-daemon (this package)
  ↑ depends on: adapter-anthropic, agent-spec, agent-fs,
                core, framework, harness, runner-protocol
  ↑ depended on by: apps/backend (spawns instances)
```
