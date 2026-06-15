# @my-agent-team/cli

> **Layer:** L6 Surface &nbsp;|&nbsp; **Runtime:** Bun/Node &nbsp;|&nbsp; **No server ports**

## Position in the stack

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  L6  Surfaces  ┌──────────────────────┐                  │
│                │         cli          │  ◄── HERE        │
│                │  readline REPL       │                  │
│                │  local + remote mode │                  │
│                └──────────┬───────────┘                  │
│                           │                             │
│               ┌───────────┼───────────┐                 │
│               ▼           ▼           ▼                 │
│         standalone    harness     backend:3000           │
│         (core+adapter)(L4 agent)  (HTTP+SSE)            │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## What problem it solves

A universal entry point for interacting with agents — whether locally (in-process or workspace-based) or remotely (against a backend). One binary, four modes, same readline REPL experience.

## Four operating modes

```
┌─────────────────────────────────────────────────────────┐
│                    apps/cli                              │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Legacy REPL (default)                            │   │
│  │  run() loop in-process                           │   │
│  │  AnthropicChatModel + read/write/web/memory      │   │
│  │  $ my-agent-chat                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Workspace Harness                                │   │
│  │  createGenericAgent() + AgentFS                  │   │
│  │  Full plugin stack (memory, skills, task-guard)  │   │
│  │  $ my-agent-chat --workspace /path/to/project    │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Remote (thread mode)                             │   │
│  │  POST /api/threads/:id/runs + SSE events         │   │
│  │  $ my-agent-chat --backend http://localhost:3000 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Remote Conversation                              │   │
│  │  POST /api/conversations/:id/messages            │   │
│  │  @mention parsing + conversation SSE             │   │
│  │  $ my-agent-chat --backend ... --conversation c1 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Agent Management                                 │   │
│  │  DELETE /api/agents/:id (archive or hard)        │   │
│  │  $ my-agent-chat --backend ... --rm agent-42     │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## REPL features

- **Readline interface** with prompt showing current mode
- **@mention parsing** in conversation mode (`@agent-name message`)
- **Streaming output** — model responses render as chunks arrive
- **Tool call display** — shows tool invocations inline
- **Interrupt handling** — approve/deny prompts for tool permissions
- **Color output** — ANSI colors for different message roles

## Usage

```bash
# Legacy: direct model + tools (needs ANTHROPIC_API_KEY)
my-agent-chat

# Local workspace with full harness
my-agent-chat --workspace ~/my-project

# Remote against backend
my-agent-chat --backend http://localhost:3000

# Multi-agent conversation
my-agent-chat --backend http://localhost:3000 --conversation conv-abc

# Delete an agent
my-agent-chat --backend http://localhost:3000 --rm agent-42 --hard
```

## Configuration

| Env var | Required | Purpose |
|---------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes (local modes) | Anthropic API key |
| `TAVILY_API_KEY` | No (legacy mode) | Web search API key |

## Dependencies

```
apps/cli (this app)
  ↑ monorepo deps: adapter-anthropic, core, harness,
                   tools-common, agent-fs
  ↑ external: Node.js stdlib only (readline, path, crypto)
  ↑ consumed by: end users (terminal)
```
