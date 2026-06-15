# @my-agent-team/lark-bot

> **Layer:** L6 Surface &nbsp;|&nbsp; **Runtime:** Bun/Node &nbsp;|&nbsp; **Zero monorepo deps**

## Position in the stack

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  L6  Surfaces  ┌──────────────────────┐                  │
│                │      lark-bot        │  ◄── HERE        │
│                │  Feishu/Lark IM      │                  │
│                │  bridge daemon       │                  │
│                └──────────┬───────────┘                  │
│                           │                             │
│                    ┌──────┴──────┐                      │
│                    ▼             ▼                       │
│              lark-cli      backend:3000                  │
│           (IM events)   (HTTP + SSE)                    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## What problem it solves

Bridges the Lark (Feishu) IM platform with the multi-agent backend. Users chat with agents in Lark like any other contact. This daemon translates between Lark IM events and backend API calls — one process per agent, managed by the backend.

## Data flow

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│  Lark    │     │  lark-bot    │     │   backend    │
│  IM      │     │  (this app)  │     │              │
└────┬─────┘     └──────┬───────┘     └──────┬───────┘
     │                  │                    │
     │  IM message      │                    │
     │ ────────────────→│                    │
     │                  │  ingest()          │
     │                  │  POST /conversations│
     │                  │  POST /messages    │
     │                  │ ──────────────────→│
     │                  │                    │ agent runs
     │                  │  SSE events        │
     │                  │ ←──────────────────│
     │                  │                    │
     │  sendMessage()   │                    │
     │ ←────────────────│                    │
     │  (Lark card)     │                    │
     │                  │                    │
     │  30s heartbeat   │                    │
     │                  │ ──────────────────→│
     │                  │                    │
```

## Inbound pipeline (Lark → Backend)

```
lark-cli event consume
  → event-parser (JSON line → typed event)
    → @mention detection
      → inbound dedup check (SQLite idempotency)
        → reserve conversation (POST /api/conversations)
          → add members (POST /api/conversations/:id/members)
            → POST message (POST /api/conversations/:id/messages)
              → confirm (to Lark)
```

## Outbound pipeline (Backend → Lark)

```
SSE watcher per conversation binding
  → receive ledger entry from backend
    → project to Lark message format
      → render markdown to Lark card
        → send to Lark via lark-cli

Run delta watcher
  → receive run deltas during agent execution
    → render streaming card (typing indicator → partial output)
      → update card as new deltas arrive
        → finalize card when run completes
```

## Key features

- **Idempotent inbound** — SQLite-backed dedup prevents double-processing of Lark events
- **Conversation binding** — persistent mapping of Lark `chatId` ↔ backend `conversationId`
- **Streaming cards** — agent output renders incrementally as Lark interactive cards
- **Typing indicators** — shows typing reaction during active runs
- **Conversation rebind** — handles `surface.control` for start-new-conversation
- **PID locking** — prevents duplicate bot instances per agent
- **Health heartbeat** — reports surface health to backend every 30s

## Startup sequence

```
bootstrap()
  → acquire PID lock
  → fetch agent info from backend (exit if archived/disabled)
  → open local SQLite bindings DB
  → restore chat↔conversation bindings
  → start SSE watchers for restored bindings
  → start 30s heartbeat interval
  → spawn lark-cli event consume (IM message stream)
  → pipe stdout → event-parser → ingest()

SIGTERM/SIGINT
  → forward to lark-cli subprocess
  → close SSE watchers
  → release PID lock
```

## Configuration

| Arg | Default | Purpose |
|-----|---------|---------|
| `--agent-id` | (required) | Which agent this bot represents |
| `--backend-url` | `http://localhost:3000` | Backend API URL |
| `--state-root` | (required) | PID lock + SQLite directory |
| `--bot-display-name` | (required) | Display name in Lark |
| `--agent-name` | (required) | Agent's name |
| `--lark-profile` | (required) | lark-cli profile name |
| `--backend-auth-token` | (required) | Bearer token for backend API |

## Dependencies

```
apps/lark-bot (this app)
  ↑ monorepo deps: NONE (zero workspace dependencies)
  ↑ external: bun:sqlite, lark-cli binary, Node.js stdlib
  ↑ managed by: apps/backend (DevLarkBotRegistry / ProdLarkBotRegistry)
```
