# my-agent

<p align="center">
  <strong>AI Coding Agent — Terminal TUI + Feishu Bridge, start a session with one message</strong>
</p>

<p align="center">
  <a href="README.md">中文</a> | English
</p>

---

**Two modes, one Agent engine:**

| Mode | Entry | Use Case |
|------|-------|----------|
| 🖥️ **Terminal TUI** | `bun tui` | Local dev, streaming output, syntax highlighting |
| 📱 **Feishu Bot** | `bun daemon <agent>` | Message in topic group → Agent responds, streaming cards |

---

## Why my-agent

- **Structured event stream**: a single `DataPlaneEvent` bus drives every frontend — Feishu cards render Markdown directly, no screenshot pipeline.
- **Built-in memory**: SQLite + FTS5 + vector hybrid retrieval, per-agent isolated memory.
- **Per-agent isolation**: each agent has its own system prompt, tool allowlist, workspace, and memory.
- **Chat-native interaction**: typing-indicator reactions, dangerous-command confirmation cards, `ask_user_question` option cards.
- **Lobster v2.0 kernel**: 12 hooks + 18 extensions on a single event bus; every subsystem ships as a `defineExtension` call.

---

## Features

### 🖥️ Terminal TUI

Chat with an AI Agent directly in your terminal.

- **Full autonomous loop**: reasoning → tool calls → response.
- **Multi-provider**: Claude, OpenAI.
- **Sub-Agent delegation**: isolate large tasks to independent child agents.
- **5-tier context compaction**: snip → summarize → emergency truncate → collapse.
- **Slash commands**: `/clear` `/compact` `/cost` `/tools` `/cancel` `/daemon` `/exit` `/help` (full table below).
- **Token budget bar**: color-coded context-pressure indicator.

### 📱 Feishu Bot

Message in a Feishu topic group, the Agent automatically starts an isolated session.

- **Topic + group chat**: auto-detects chat type, per-topic isolated context.
- **Streaming cards**: real-time Markdown rendering, no screenshots.
- **Multi-bot**: multiple daemon processes, independent agent config + memory.
- **Interactive confirmation**: dangerous-command cards, `ask_user_question` option cards.
- **Session persistence**: daemon restart auto-recovers session context.
- **TUI ↔ IM bridge**: browse and resume Feishu sessions from `/daemon` in TUI.

### 🧩 Per-Agent Workspace

Each agent has its own identity, memory, and workspace:

```
~/.my-agent/agents/<id>/
  AGENTS.md      → operating rules
  SOUL.md        → personality
  IDENTITY.md    → identity
  memory.db      → isolated memory database
  sessions/      → session persistence
```

### 🧠 More

- **Memory**: SQLite + FTS5 + vector hybrid retrieval.
- **Skills**: teach the agent new workflows with Markdown files.
- **Self-Evolution**: auto-analyze traces and generate skill proposals.
- **Session**: named save / load.

---

## 5-Minute Quick Start (Feishu Bot)

### Step 1: Create a Feishu App

Open [Feishu Open Platform](https://open.larkoffice.com/app), click "Create Enterprise App".

### Step 2: Get Credentials

App details → "Credentials & Basic Info", copy **App ID** and **App Secret**.

### Step 3: Add Permissions

Under "Permissions", add:

- `im:message`
- `im:message:send_as_bot`
- `im:message:readonly`
- `im:chat:read`

### Step 4: Install & Configure

```bash
bun install
cp .env.example .env  # Set ANTHROPIC_API_KEY
bun bot               # Interactive bot + agent wizard
```

### Step 5: Configure Event Subscription

Back in Feishu Open Platform, under "Events & Callbacks":

1. Choose "Long-lived Connection".
2. Add event: `im.message.receive_v1`.
3. Enable "Card Callback" (`card.action.trigger`).

### Step 6: Start Daemon

```bash
bun daemon <agent-name>
```

### Step 7: Publish & Test

1. Feishu → "Version Management" → "Create Version" → "Only me" → Publish.
2. Create a topic group → Group Settings → Add bot.
3. Send a message to confirm.

---

## Local Development (Terminal TUI)

```bash
git clone https://github.com/Chengchcc/my-agent-dev.git
cd my-agent-dev
bun install
cp .env.example .env  # Set ANTHROPIC_API_KEY

bun tui
# or headless:
bun agent "Explain the authentication flow"
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `bun tui` | Launch terminal UI |
| `bun agent "<prompt>"` | Headless single run |
| `bun bot` | Interactive bot + agent setup |
| `bun daemon <agent>` | Start Feishu daemon |
| `bun daemon list` | List running daemons |
| `bun daemon stop <agent>` | Stop daemon |

Each CLI-bearing extension also exposes its own `my-agent <name> ...` subcommand:

| Subcommand | Description |
|---|---|
| `my-agent trace ...` | Trace query / export |
| `my-agent memory ...` | Memory CRUD |
| `my-agent skills ...` | Skill list / enable / disable |
| `my-agent evolution list / promote / discard / stats` | Manage evolution proposals |
| `my-agent mcp ...` | MCP server management |

### TUI Slash Commands

Built-in commands (live in `src/application/slash/builtin/`):

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation |
| `/compact` | Trigger context compaction |
| `/cost` | Token usage for this session |
| `/tools` | List / toggle tools |
| `/cancel` | Cancel the current turn |
| `/daemon` | Browse daemon sessions |
| `/exit` | Quit |

> **Known M1 caveat**: extension-contributed slashes (`/trace`, `/memory`, `/evolve`, …) are not yet wired into the frontend. They are silently ignored at this cut and tracked as a P0 fix before merge to `master`.

---

## Configuration

### Lark Bot Config

Lark Bot config is stored in the SQLite agent registry (`~/.my-agent/agents.db`), one record per agent. Configured via CLI:

```bash
# Create an agent with Lark Bot config
bun cli agent create
# Or manage Lark config after creation
bun cli agent lark set -a <agent-name>
```

Fields: `appId` (Feishu App ID), `appSecretEnv` (env var name — never stores the plaintext secret).

### settings.yml

```yaml
# ~/.my-agent/settings.yml
llm:
  provider: claude
  model: claude-opus-4-7
context:
  tokenLimit: 200000
security:
  allowedRoots:
    - ~/projects
```

---

## File Locations

| Path | Description |
|------|-------------|
| `~/.my-agent/agents.db` | SQLite agent registry (Lark config, etc.) |
| `~/.my-agent/settings.yml` | Global Agent config |
| `~/.my-agent/agents/<id>/` | Agent workspace (identity.md, sessions/, memory/) |
| `~/.my-agent/agents/<id>/logs/` | Daemon logs |
| `~/.my-agent/agents/<id>/daemon.sock` | Daemon Unix socket |
| `~/.my-agent/trash/` | Deleted agent backup (30-day auto-cleanup) |

---

## Project Structure

```
my-agent/
├── bin/                        # CLI entry points (thin wrappers)
│   ├── my-agent-cli.ts         # CLI dispatch
│   └── my-agent-daemon.ts      # Daemon process entry
├── src/
│   ├── kernel/                 # Extension system core (DI, event bus, hooks, RPC)
│   │   ├── kernel.ts           # createKernel() factory
│   │   ├── define-extension.ts # defineExtension() registration
│   │   ├── event-bus.ts        # Pub/sub event broker
│   │   ├── hook-container.ts   # 12-hook dispatcher (3 modes)
│   │   ├── extension-registry.ts # Capability + slash collection
│   │   └── rpc-registry.ts     # JSON-RPC method dispatch table
│   ├── application/
│   │   ├── contracts/          # Cross-boundary data contracts (events, envelopes, codecs)
│   │   ├── ports/              # Abstract interfaces (anti-corruption layer)
│   │   ├── slash/              # Slash registry + built-ins (A18.5)
│   │   └── usecases/           # Pure orchestration (no IO)
│   ├── domain/                 # Pure domain entities (Session, Turn, TurnEvent, etc.)
│   ├── extensions/             # 18 extensions (provider, memory, session, tools, evolution, …)
│   │   ├── presets.ts          # Extension presets (TUI / headless / daemon)
│   │   ├── frontend.tui/       # Ink/React terminal UI
│   │   ├── frontend.lark/      # Feishu bot adapter
│   │   └── ...
│   ├── infrastructure/         # Adapter implementations (LLM, transport, memory, paths, config)
│   └── cli/                    # CLI subcommand router
├── skills/                     # Skill definitions
├── docs/                       # Spec + Plan docs
└── tests/                      # Test suite
```

## Development

```bash
bun install              # Install dependencies
bun tui                  # Launch TUI
bun tsc                  # Type check
bun test                 # Run tests
bun run check:all        # Full CI (tsc + tests + arch guard + deadcode)
bun run lint             # ESLint
```

## License

MIT
