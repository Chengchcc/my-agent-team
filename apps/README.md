# Apps

## Position in the stack

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  L6  Surfaces   web:3001     cli        lark-bot        │
│                 (Next.js)   (REPL)    (IM bridge)       │
│                   │           │           │              │
│                   │   HTTP    │   HTTP    │  HTTP        │
│                   ▼           ▼           ▼              │
│  L5  Backend  ┌──────────────────────────────┐          │
│               │        backend:3000           │          │
│               │   REST API + SSE + runner     │          │
│               │   pool + conversations        │          │
│               └──────────────────────────────┘          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## App list

| App | Surface | Runtime | Port | Monorepo deps |
|-----|---------|---------|------|--------------|
| [`web`](./web/) | Browser UI | Next.js 15 | 3001 | 0 |
| [`cli`](./cli/) | Terminal | Bun/Node | — | 5 |
| [`lark-bot`](./lark-bot/) | Feishu IM | Bun/Node | — | 0 |
| [`backend`](./backend/) | Server (L5) | Bun | 3000 | 9 |

## Communication patterns

### Browser (web)
```
Browser ──→ /api/bff/[...path] ──→ backend:3000
        ←── SSE passthrough    ←──
```
The BFF proxy injects `x-auth-token` + `x-user-id` headers. Browser never sees backend credentials.

### Terminal (cli)
```
Terminal ──→ POST /api/threads/:id/runs ──→ backend:3000
         ←── SSE /api/runs/:id/events   ←──
```
Can also run fully standalone (in-process agent loop, no backend needed).

### Feishu/Lark (lark-bot)
```
Lark IM ──→ lark-cli stdout ──→ lark-bot ──→ POST /api/conversations/:id/messages ──→ backend:3000
         ←── lark-cli stdin  ←── lark-bot ←── SSE /api/conversations/:id/events  ←──
```
One lark-bot process per agent, managed by backend's `LarkBotRegistry`.

### Daemon management (backend → runner)
```
backend:3000 ──→ spawn/kill runner-daemon subprocess (dev)
             ──→ connect Unix socket            (prod)
             ←── NDJSON events via runner-protocol
```

## How to run

```bash
# Terminal 1: Backend
cd apps/backend
ANTHROPIC_API_KEY=sk-... BACKEND_AUTH_TOKEN=dev bun run src/main.ts

# Terminal 2: Web UI
cd apps/web
BACKEND_URL=http://localhost:3000 BACKEND_TOKEN=dev bun run dev

# Terminal 3: CLI (standalone)
cd apps/cli
ANTHROPIC_API_KEY=sk-... bun run src/main.ts

# Terminal 4: CLI (remote against backend)
bun run src/main.ts --backend http://localhost:3000
```

## Which surface to use

| When you want to... | Use |
|---------------------|-----|
| Manage agents, view conversations in a browser | `web` (Observatory UI) |
| Chat with agents in terminal | `cli` |
| Chat with agents in Feishu/Lark IM | `lark-bot` |
| Host multi-agent orchestration | `backend` |
