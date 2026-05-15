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
|------|------|---------|
| 🖥️ **Terminal TUI** | `bun tui` | Local dev, streaming output, syntax highlighting |
| 📱 **Feishu Bot** | `bun daemon <profile>` | Message in topic group → Agent responds, streaming cards |

---

## Why my-agent

- **Structured Agent Events**: 16 AgentEvent types stream directly to Feishu Markdown cards — no screenshot pipeline needed
- **Built-in Memory**: SQLite + FTS5 + vector hybrid retrieval, per-bot isolated memory
- **Profile System**: Per-bot identity (system prompt, tool allowlist, workspace)
- **Chat-native Interaction**: Typing indicator reactions, plain text cards — no card buttons

---

## Features

### 🖥️ Terminal TUI

Chat with an AI Agent directly in your terminal.

- **Full autonomous loop**: reasoning → tool calls → response
- **Multi-provider**: Claude, OpenAI
- **Sub-Agent delegation**: Isolate large tasks to independent child agents
- **5-tier context compaction**: snip → summarize → truncate → collapse
- **Slash commands**: `/clear` `/compact` `/sessions` `/tasks` `/memory` `/review` `/daemon`
- **Token budget bar**: Color-coded context pressure indicator

### 📱 Feishu Bot

Message in a Feishu topic group, the Agent automatically starts an isolated session.

- **Topic + group chat**: Auto-detects chat type, per-topic isolated context
- **Streaming cards**: Real-time Markdown rendering, no screenshots
- **Multi-bot**: Multiple daemon processes, independent Profile + Memory
- **Chat-native**: Emoji reaction typing indicator, plain text responses
- **Session persistence**: Daemon restart auto-recovers session context
- **TUI ↔ IM**: Browse and resume Feishu sessions from `/daemon` in TUI

### 🧠 Profile System

Each bot has its own identity, memory, and workspace.

```
~/.my-agent/profiles/<id>/
  AGENTS.md      → operating rules
  SOUL.md        → personality
  IDENTITY.md    → identity
  memory.db       → isolated memory
  sessions/       → session persistence
  workspace/      → default working directory
```

### 🧩 More

- **Memory**: SQLite + FTS5 + vector hybrid retrieval
- **Skills**: Teach the agent workflows with Markdown files
- **Self-Evolution**: Auto-analyze traces and generate skills
- **Session**: Named conversation save/load

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
bun cli profile setup  # Interactive bot + profile wizard
```

### Step 5: Configure Event Subscription

Back in Feishu Open Platform, under "Events & Callbacks":

1. Choose "Long-lived Connection"
2. Add event: `im.message.receive_v1`
3. Enable "Card Callback" (`card.action.trigger`)

### Step 6: Start Daemon

```bash
bun daemon start <profile-name>
```

### Step 7: Publish & Test

1. Feishu → "Version Management" → "Create Version" → "Only me" → Publish
2. Create a topic group → Group Settings → Add bot
3. Send a message to confirm

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
| `bun cli profile setup` | Interactive bot + profile setup |
| `bun cli profile list` | List configured profiles |
| `bun cli daemon start <p>` | Start daemon for profile |
| `bun cli daemon stop <p>` | Stop daemon |
| `bun cli daemon restart <p>` | Restart daemon |
| `bun cli daemon list` | List running daemons |

### TUI Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation |
| `/compact` | Trigger context compaction |
| `/sessions save <name>` | Save current session |
| `/sessions load <name>` | Load saved session |
| `/sessions list` | List all sessions |
| `/tasks` | Show task list |
| `/memory search <query>` | Search memory |
| `/review list` | View auto-generated skills |
| `/daemon` | Browse daemon sessions |
| `/exit` | Quit |

---

## Configuration

### bots.yml

```yaml
# ~/.my-agent/bots.yml
profiles:
  backend-expert:
    dataDir: ~/.my-agent/profiles/backend-expert
    toolProfile: code_editor
    workingDir: ~/.my-agent/profiles/backend-expert/workspace
    permissionTimeoutMs: 60000

bots:
  - larkAppId: cli_xxxxxxxxxxxx
    larkAppSecret: xxxxxxxxxxxxxxxxxxxx
    profileId: backend-expert
    allowedUsers:
      - alice@example.com
```

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
| `~/.my-agent/bots.yml` | Bot + Profile config |
| `~/.my-agent/settings.yml` | Global Agent config |
| `~/.my-agent/profiles/<id>/` | Profile workspace (AGENTS.md, SOUL.md, memory.db) |
| `~/.my-agent/data/` | Daemon PID files |
| `~/.my-agent/sessions/` | TUI session persistence |
| `~/.my-agent/traces/` | Agent run traces |
| `~/.my-agent/memory/` | Global memory database |

---

## Project Structure

```
my-agent/
├── bin/                        # CLI entry points
│   ├── my-agent-tui-dev.ts     # TUI dev entry
│   ├── my-agent.ts             # Headless agent
│   ├── my-agent-cli.ts         # Bot/Daemon management CLI
│   └── my-agent-daemon.ts      # Daemon process entry
├── src/
│   ├── agent/                  # Agent loop, context, tool dispatch
│   ├── cli/tui/                # Ink/React terminal UI
│   ├── config/                 # YAML + Zod configuration
│   ├── daemon/                 # IM bridge layer
│   │   ├── daemon.ts           # Central orchestrator
│   │   ├── session-manager.ts  # Agent instance pool
│   │   ├── session-handlers.ts # Message handlers
│   │   └── card-pipeline.ts    # AgentEvent → Feishu cards
│   ├── evolution/              # Self-evolution system
│   ├── im/lark/                # Feishu integration
│   │   ├── client.ts           # Lark API client
│   │   ├── event-dispatcher.ts # WS long connection + routing
│   │   ├── card-builder.ts     # Card builder
│   │   └── message-parser.ts   # Message parser
│   ├── memory/                 # Persistent memory
│   ├── mcp/                    # MCP client
│   ├── profile/                # Profile system
│   ├── providers/              # Claude + OpenAI providers
│   ├── session/                # Session persistence
│   ├── skills/                 # Skill loading + injection
│   ├── tools/                  # Built-in tools
│   ├── trace/                  # Trace recording
│   ├── utils/                  # Utilities
│   ├── runtime.ts              # Single assembly point
│   └── types.ts                # Global types
├── skills/                     # Skill definitions
├── docs/superpowers/           # Spec + Plan docs
└── tests/                      # Test suite (649+ tests)
```

## Development

```bash
bun install              # Install dependencies
bun tui                  # Launch TUI
bun tsc                  # Type check
bun test                 # Run tests
bun run check:all        # Full CI (tsc + tests + arch guard)
bun run lint             # ESLint
```

## License

MIT
