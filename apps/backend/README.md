# @my-agent-team/backend

> **Layer:** L5 Backend &nbsp;|&nbsp; **Runtime:** Bun &nbsp;|&nbsp; **Port:** 3000 (default)

## Position in the stack

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  L6  Surfaces    web:3001    cli     lark-bot            │
│                    │          │         │                │
│                    ▼          ▼         ▼                │
│  L5  Backend   ┌──────────────────────────────┐         │
│                │         backend:3000          │ ◄─ HERE │
│                │  REST + SSE + runner pool     │         │
│                └──────────┬───────────────────┘         │
│                           │ Unix sockets                │
│                ┌──────────▼───────────────────┐         │
│                │  runner-daemon (× N agents)  │         │
│                └──────────────────────────────┘         │
│  L4  Harness   harness / framework / core               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## What problem it solves

The central orchestration server that ties everything together. It manages agent lifecycles (create, configure, delete), dispatches runs to per-agent runner daemons, streams events to clients via SSE, handles multi-agent conversations with @-mention routing, and exposes operational diagnostics.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    HTTP Server (Bun)                     │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │  Agents  │  │   Runs   │  │  Convos  │  │   Ops   │ │
│  │  CRUD    │  │dispatch  │  │ members  │  │ traces  │ │
│  │ identity │  │ SSE      │  │ messages │  │ health  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │             │             │             │       │
│  ┌────▼─────────────▼─────────────▼─────────────▼────┐  │
│  │                  Service Layer                    │  │
│  │  AgentService  RunService  ConversationService    │  │
│  │  ThreadProjectionService  RuntimeOpsService       │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │                              │
│  ┌──────────────────────▼───────────────────────────┐  │
│  │                  Data Layer                       │  │
│  │  backend.db (SQLite)     events.db (SQLite)       │  │
│  │  agents, members,        event_log, runs,         │  │
│  │  conversations           attempts, ops            │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Runner Registry                      │   │
│  │  Dev:  spawn runner-daemon subprocess × N        │   │
│  │  Prod: connect to pre-deployed Unix sockets       │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## API surface

### Agent management
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create agent |
| `GET` | `/api/agents/:id` | Get agent |
| `PATCH` | `/api/agents/:id` | Update agent |
| `DELETE` | `/api/agents/:id` | Archive (soft) or `?hard=true` (hard delete) |
| `GET` | `/api/agents/:id/identity` | Read SOUL.md / USER.md / memory |
| `PUT` | `/api/agents/:id/identity` | Write SOUL.md / USER.md / memory |

### Runs
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/threads/:id/runs` | Start run (legacy thread-based) |
| `GET` | `/api/runs/:id` | Get run status |
| `GET` | `/api/runs/:id/events` | SSE stream of run events |
| `GET` | `/api/runs/:id/stream` | SSE text-only delta stream |
| `POST` | `/api/runs/:id/cancel` | Cancel running run |
| `POST` | `/api/runs/:id/resume` | Resume after interrupt |

### Conversations (multi-agent)
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/conversations` | List conversations |
| `POST` | `/api/conversations` | Create conversation |
| `DELETE` | `/api/conversations/:id` | Delete conversation |
| `POST` | `/api/conversations/:id/members` | Add member |
| `POST` | `/api/conversations/:id/messages` | Post message (triggers agent runs) |
| `GET` | `/api/conversations/:id/events` | SSE stream of conversation events |

### Operations
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/ops/runs` | All runs (filterable) |
| `POST` | `/api/ops/runs/:id/cancel` | Force cancel |
| `POST` | `/api/ops/runs/:id/recover` | Recover stuck run |
| `GET` | `/api/ops/agents/:id/runtime` | Agent runtime diagnostics |
| `GET` | `/api/ops/traces/:traceId` | Distributed trace detail |
| `GET` | `/api/ops/surfaces` | Surface health (Lark bots, etc.) |

## Startup sequence

```
loadConfig() from env
  → open backend.db + events.db (SQLite)
  → create RunnerRegistry (dev: spawn daemons, prod: connect sockets)
  → create RunSupervisor + EventLog
  → create services (Agent, Conversation, Run, ThreadProjection, RuntimeOps)
  → build HTTP router + auth middleware
  → rediscover live runs from event log
  → launch Lark bots for enabled agents
  → Bun.serve({ port, host, idleTimeout: 0 })
  → graceful shutdown on SIGTERM/SIGINT
```

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `BACKEND_PORT` | `3000` | HTTP listen port |
| `BACKEND_HOST` | `127.0.0.1` | HTTP listen host |
| `BACKEND_DATA_DIR` | `./data` | SQLite + workspace root |
| `BACKEND_AUTH_TOKEN` | (required) | Bearer token for API auth |
| `ANTHROPIC_API_KEY` | (required) | Passed to runner daemons |
| `RUNNER_ENV` | `dev` | `dev` = spawn subprocess, `prod` = Unix sockets |
| `BACKEND_MAX_CONCURRENT_RUNS` | `8` | Max runs across all agents |
| `BACKEND_LOG_LEVEL` | `info` | Logging level |

## Dependencies

```
apps/backend (this app)
  ↑ monorepo deps: adapter-anthropic, agent-spec, conversation,
                   core, event-log, framework, harness,
                   runner-protocol, runtime-observability
  ↑ external: zod, bun:sqlite
  ↑ consumed by: apps/web, apps/cli, apps/lark-bot (all HTTP clients)
```
