# @my-agent-team/web

> **Layer:** L6 Surface &nbsp;|&nbsp; **Framework:** Next.js 15 &nbsp;|&nbsp; **Port:** 3001 (dev)

## Position in the stack

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  L6  Surfaces  ┌──────────────────────┐                  │
│                │         web          │  ◄── HERE        │
│                │  Next.js 15 + React  │                  │
│                │  "Observatory" UI    │                  │
│                └──────────┬───────────┘                  │
│                           │                             │
│                    /api/bff/[...path]                    │
│                    (BFF proxy)                           │
│                           │                             │
│  L5  Backend   ┌──────────▼───────────┐                 │
│                │     backend:3000     │                 │
│                └──────────────────────┘                 │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## What problem it solves

A web-based observatory for managing agents, conducting multi-agent conversations, and monitoring runtime operations. All browser requests go through a BFF (Backend-for-Frontend) proxy that injects auth tokens — the browser never sees backend credentials.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Next.js 15 App                       │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Agents  │  │ Conversations│  │       Ops        │  │
│  │  CRUD    │  │  timeline    │  │  runs, traces,   │  │
│  │ identity │  │  composer    │  │  agents, surfaces│  │
│  │ Lark setup│ │  @mentions   │  │  diagnostics     │  │
│  └────┬─────┘  └──────┬───────┘  └────────┬─────────┘  │
│       │               │                   │            │
│  ┌────▼───────────────▼───────────────────▼─────────┐  │
│  │            TanStack Query (data layer)            │  │
│  │  typed fetch → /api/bff/[...path]                │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │                              │
│  ┌──────────────────────▼───────────────────────────┐  │
│  │              BFF Proxy (/api/bff)                 │  │
│  │  session cookie → auth token injection            │  │
│  │  hop-by-hop header stripping                      │  │
│  │  SSE passthrough for streaming                    │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │                              │
│                    backend:3000                         │
└─────────────────────────────────────────────────────────┘
```

## Pages

### Agent management
| Route | Purpose |
|-------|---------|
| `/agents` | Agent list with create, archive, delete |
| `/agents/[id]` | Agent detail — config, identity (SOUL/USER), Lark setup, conversation list |

### Conversations
| Route | Purpose |
|-------|---------|
| `/conversations/[id]` | Conversation canvas with message timeline, streaming runs, tool approvals, reasoning traces, @-mention composer |

### Operations
| Route | Purpose |
|-------|---------|
| `/ops` | Dashboard overview |
| `/ops/runs` | All runs (filterable by status, transport, heartbeat) |
| `/ops/runs/[runId]` | Run detail with events and diagnosis |
| `/ops/agents` | Agent runtime status overview |
| `/ops/agents/[agentId]` | Single agent runtime diagnostics |
| `/ops/traces` | Distributed trace list |
| `/ops/traces/[traceId]` | Trace detail with span tree |
| `/ops/surfaces` | Surface health (Lark bots, CLI sessions) |

### Auth
| Route | Purpose |
|-------|---------|
| `/login` | Login page (public, no auth required) |

## Key components

| Component | Purpose |
|-----------|---------|
| `AppShell` | Layout shell with collapsible sidebar |
| `NavRail` | Navigation sidebar — Workspace (agents + conversations) + Operations |
| `AgentForm` | Create/edit agent with model, permission, Lark config |
| `ConversationCanvas` | Full conversation view: timeline + composer |
| `Timeline` | Scrollable message history |
| `MessageBubble` | Single message with role indicator, markdown body |
| `Composer` | Input with @-mention autocomplete |
| `ReasoningTrace` | Expandable reasoning display |
| `ToolApprovalCard` | Inline tool permission approve/deny |
| `IdentityPanel` | SOUL.md / USER.md editor |
| `Markdown` | Markdown renderer with syntax highlighting |

## Tech stack

| Category | Choices |
|----------|---------|
| Framework | Next.js 15 (App Router) |
| UI | React 19, Tailwind CSS 4, shadcn/ui |
| Data | TanStack Query (React Query) |
| Auth | Cookie-based session (HMAC) with middleware guard |
| Streaming | SSE passthrough via BFF |
| Markdown | react-markdown + remark-gfm |
| Icons | lucide-react |
| Toasts | sonner |
| Theme | next-themes (dark/light mode) |

## Configuration

| Env var | Purpose |
|---------|---------|
| `BACKEND_URL` | Backend API base URL (e.g., `http://localhost:3000`) |
| `BACKEND_TOKEN` | Bearer token injected by BFF proxy |
| `PORT` | Dev server port (default `3001`) |

## Dependencies

```
apps/web (this app)
  ↑ monorepo deps: NONE (standalone frontend)
  ↑ external: next, react, @tanstack/react-query, tailwindcss,
              @base-ui/react, lucide-react, react-markdown,
              sonner, next-themes, shadcn/ui
  ↑ consumed by: end users (browser)
```
