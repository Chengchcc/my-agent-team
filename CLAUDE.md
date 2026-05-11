# CLAUDE.md

---

## ⚠️ ARCHITECTURE CONSTITUTION — MANDATORY READ FIRST

**All code generated in this repository must comply with the [Architecture Constitution](./ARCHITECTURE-CONSTITUTION.md).**

These are non-negotiable, CI-enforced rules. Violations will block your PR. Read the full constitution **before writing any code**.

**Summary of violations that will block your code:**
- Instantiating `Agent`, `ToolRegistry`, `ContextManager`, or providers directly in `bin/*`
- Adding new `any` types or unsafe casts
- Adding new `syncTodoFromContext` calls
- Using `console.log` instead of `debugLog`
- Unannotated `@ts-ignore` / `@ts-expect-error`
- Files > 400 lines or functions > 80 lines without justification
- New public APIs without unit tests

---

## 🎨 Design Philosophy — Read Before Designing New Features

**Before writing any code for a new feature, read the [Design Philosophy](./DESIGN-PHILOSOPHY.md).**

This document captures the design taste and recurring patterns that make this codebase coherent. It exists to ensure every new feature feels like it belongs — same patterns, same rhythm, same judgment. The 15 patterns in that document are your first draft for any design decision.

Core patterns at a glance:
- **Single assembly point** — wire in `createAgentRuntime()`, never in `bin/*`
- **Onion middleware** — cross-cutting concerns are middleware, not new classes
- **Everything is a tool** — the LLM only knows `function_call`, so every capability is a tool
- **Discriminated unions** — `switch(event.type)` with exhaustive `never`, never cast
- **Progressive disclosure** — metadata eagerly, full content on demand
- **Least-destructive-first** — graduated response, never "fine" → "nuclear"
- **Zod at boundaries** — parse, don't validate; schema derives the type

## Design Overview

For a comprehensive walkthrough of the project's architecture — the agent loop, tool dispatch pipeline, memory system, skills, compaction, TUI, and how everything fits together — read the **[Design Document](./DESIGN.md)**.

## Current State

This is a TypeScript-based AI agent framework built with Bun, featuring a modular architecture for extending functionality through skills, and an interactive terminal UI (TUI) powered by Ink/React. The project includes a self-evolution system that analyzes agent traces, creates skills, and evaluates their effectiveness through a multi-tier review pipeline.

**Self-Evolution Phases Complete:** Phase A (P0 fixes) → B (defense layers) → C (lifecycle) → D (tiered queue) → E (triggers). Phase F (prompt self-evolution) pending.

## Development Commands

- **Compile TypeScript**: `bun run tsc` (alias: `bun run build`)
- **Run TUI in development**: `bun run tui` (alias: `bun run dev`)
- **Run headless agent**: `bun run agent` (alias: `bun run headless`)
- **Run tests**: `bun test`
- **Lint**: `bun run lint`
- **Type check only**: `bun run check:guard`
- **Architecture check**: `bun run check:arch`
- **Dead code check**: `bun run check:deadcode`
- **Full CI check**: `bun run check:all` (typecheck + tests + architecture)
- **Update any baseline**: `bun run baseline:any`
- **Install git hooks**: `bun run prepare`
- **TypeScript version**: ^6.0.3

## Architecture

### Core Files

- `/src/index.ts`: Main entry point with public exports (types, agent, providers, skills, tools, todos, session)
- `/src/types.ts`: Global shared type definitions (ContentBlock, Message, Tool, ToolCall, Provider, Middleware, AgentHooks, AgentContext, AgentConfig, CompressionStrategy, etc.)
- `/src/runtime.ts`: Unified runtime — `createAgentRuntime()` is the single assembly point wiring all subsystems (provider, tools, MCP, memory, skills, todos, session, compaction, trace/evolution)
- `/src/runtime-providers.ts`: `createProviderFromEnv()` for headless auto-detect and `setupEvolution()` for wiring evolution into TUI store

### Agent Module (`/src/agent/`)

- `Agent.ts`: Agent class with `getContext()`, `clear()`, `abort()`, `getContextManager()`, `getModelName()`
- `agent-loop.ts`: AgentLoop class — async generator yielding AgentEvents per turn
- `loop-types.ts`: AgentEvent discriminated union (~16 variants: text_delta, thinking_delta, thinking_done, tool_call_start, tool_call_result, turn_complete, agent_done, agent_error, sub_agent_start, sub_agent_event, sub_agent_done, budget_delegation, budget_compact, context_compacted, mcp_status, evolution_review_done), plus AgentLoopConfig and DEFAULT_LOOP_CONFIG
- `loop-utils.ts`: Loop utility helpers
- `context.ts`: ContextManager + TrimOldestStrategy for message store and trimming
- `middleware.ts`: `composeMiddlewares()` onion composer
- `dispatch.ts`: Tool dispatch orchestration
- `tool-registry.ts`: ToolRegistry — manages tool registration, lookup, and conflict resolution
- `sub-agent-tool.ts`: SubAgentTool — delegates subtasks to independent child agents
- `sub-agent-config.ts`: Sub-agent configuration
- `single-turn.ts`: Single LLM turn execution
- `run-tools.ts`: Tool execution within a turn
- `rate-limiter.ts`: Rate limiting
- `token-accumulator.ts`: O(1) incremental token tracking
- `trim-strategy.ts`: Message trimming logic
- `budget-guard.ts`: Token budget enforcement (delegate/compact triggers)
- `compaction/`: Advanced context compression system (5-tier: 0=none, 1=snip, 2=auto-compact, 3=reactive, 4=collapse)
  - `compaction-manager.ts`: TieredCompactionManager — orchestrates compression strategies
  - `types.ts`: Compaction type definitions (CompactionLevel, CompactionLevelType)
  - `budget.ts`: TokenBudgetCalculator for budget tracking
  - `tiers/snip.ts`: Snip compaction (tier 1, 60-75%)
  - `tiers/auto-compact.ts`: Automatic compaction (tier 2, 75-95%)
  - `tiers/reactive.ts`: Reactive compaction (tier 3, API error response)
  - `tiers/collapse.ts`: Collapse compaction (tier 4, >95%)
- `tool-dispatch/`: Tool execution middleware pipeline
  - `dispatcher.ts`: ToolDispatcher — dispatches tool calls, builds middleware chain, handles timeout and serialization
  - `types.ts`: Tool dispatch type definitions
  - `middleware.ts`: ToolMiddleware interface and composition
  - `middlewares/permission.ts`: PermissionMiddleware — deny-list for sub-agents
  - `middlewares/read-cache.ts`: ReadCacheMiddleware — caches read operations
- `index.ts`: Module exports

### Runtime Module

- `/src/runtime.ts`: `createAgentRuntime()` — single assembly point for all subsystems
  - `RuntimeConfig`: Configuration interface (provider, model, maxTokens, tokenLimit, cwd, enableMemory/Skills/Todo/Session/Compaction/Mcp, systemPrompt, allowedRoots, askUserQuestionHandler, settings, mcpServers)
  - `AgentRuntime`: Returned interface (agent, provider, toolRegistry, contextManager, sessionStore, memoryMiddleware, skillLoader, mcpManager, shutdown)
  - Internal helpers: `setupMemory()`, `setupCompaction()`, `assembleMcp()`, `setupTrace()`
- `/src/runtime-providers.ts`: Provider auto-detection and evolution setup for TUI

### Configuration (`/src/config/`)

- `types.ts`: Full Settings interface (llm, context, memory, skills, tui, subAgent, security, tools, debug, mcp, trace)
- `schema.ts`: Zod validation schemas for all settings
- `defaults.ts`: Complete defaults object
- `loader.ts`: YAML/JSON file loading, deep merge, tilde expansion (settings.yml / settings.json in ~/.my-agent/)
- `index.ts`: Lazy proxy for settings singleton; `getSettings()` / `getSettingsSync()`
- `constants.ts`: Named constants (DEFAULT_MODEL, DEFAULT_MAX_TOKENS, DEFAULT_TOKEN_LIMIT, DEFAULT_THINKING_BUDGET, DEFAULT_SUMMARY_MODEL, MCP defaults, evolution defaults)
- `default-prompts.ts`: `DEFAULT_SYSTEM_PROMPT`
- `migrations.ts`: Config version migrations (v0→v1)
- `allowed-roots.ts`: Security boundary — runtime accessor for allowed root directories

### Providers (`/src/providers/`)

- `index.ts`: `createProviderFromSettings()`, re-exports ClaudeProvider, OpenAIProvider
- `claude.ts`: Anthropic Claude provider with extended thinking support
- `openai.ts`: OpenAI provider
- `claude-utils.ts`: Claude-specific utility functions
- `thinking/types.ts`: ThinkingDecoder interface
- `thinking/anthropic-native.ts`: Anthropic native thinking decoder
- `thinking/reasoning-content.ts`: Reasoning content decoder

### MCP Client (`/src/mcp/`)

- `index.ts`: Global singleton getters/setters for McpManager, ToolRegistry, PromptRegistry
- `manager.ts`: MCP client connection manager (start, shutdown, reconnect, tool/prompt discovery)
- `tools.ts`: MCP management tools (McpListServersTool, McpAddServerTool, McpRemoveServerTool, McpReadResourceTool)
- `tool-adapter.ts`: Adapts external MCP tools to internal Tool interface
- `prompt-registry.ts`: MCP prompt discovery and tool registration
- `resource-middleware.ts`: Injects MCP resource catalogs into agent context
- `server-listers.ts`: Server listing utilities
- `server-persistence.ts`: Server config persistence
- `types.ts`: MCP-specific types

### Memory System (`/src/memory/`)

- `index.ts`: Exports SqliteMemoryStore, all retrievers, MemoryMiddleware, MemoryTool, invalidateAgentMdCache
- `sqlite-store.ts`: SQLite-based memory store (~/.my-agent/memory/memory.db with FTS5)
- `retriever.ts`: Keyword token-scoring retriever
- `bm25-retriever.ts`: FTS5 BM25 retriever
- `vector-retriever.ts`: Ollama vector embedding retriever
- `hybrid-retriever.ts`: Fused RRF retriever (weights 0.5/0.3/0.2)
- `middleware.ts`: MemoryMiddleware — retrieves and injects memories before model
- `tool.ts`: MemoryTool for manual memory operations
- `extractor.ts`: LLM-based memory extraction from conversation
- `embedding-runner.ts`: Embedding computation
- `agent-md.ts`: AGENTS.md / CLAUDE.md caching and invalidation
- `dispatchers.ts`: Evolution drainer memory dispatchers
- `wire-memory-evolution.ts`: Bridges memory and evolution modules; backfillEmbeddings
- `types.ts`: Memory type definitions (MemoryRetriever, etc.)

### Skills (`/src/skills/`)

- `loader.ts`: SkillLoader — discovers SKILL.md files with YAML frontmatter from `skills/` and `~/.my-agent/skills/auto/`
- `middleware.ts`: createSkillMiddleware — injects skill metadata and full content into agent context
- `index.ts`: Module exports

### Trace System (`/src/trace/`)

- `index.ts`: `createTraceMiddleware()` factory
- `agent-middleware.ts`: TraceAgentMiddleware — records runs and sessions
- `tool-middleware.ts`: TraceToolMiddleware — records tool calls
- `store.ts`: TraceStore — NDJSON persistence in ~/.my-agent/traces/
- `nudge-engine.ts`: Signal generation (error_burst, complex_task, periodic, memory_worthy)
- `redactor.ts`: Sensitive data redaction
- `turn-settled-detector.ts`: Detects when LLM output has stabilized
- `trace-buffer.ts`: Buffered trace writing
- `types.ts`: Trace type definitions (TraceRun, TraceSummary, TraceStore)

### Self-Evolution System (`/src/evolution/`)

- `index.ts`: `initEvolution()` — EvolutionModule with review, trackStats, drainQueue; re-exports all components
- **Tier 0**: `review-agent.ts` — forks LLM agent to analyze traces and create reusable skills via `review-tools.ts`
- **Tier 1**: `effectiveness-tracker.ts` — in-line mechanical scoring (success rate, outcome classification)
- **Tier 2**: `skill-analyzer.ts` — forks LLM to judge skill quality, producing keep/edit/delete verdicts
- **Tier 3**: Deferred to Phase F — prompt self-evolution with A/B shadow evaluation
- **Queue & Scheduling**:
  - `persistent-queue.ts` — file-per-task JSON queue, O_EXCL atomic claim, mtime heartbeat, zombie recovery, per-tier backoff, kind-based subdirectories (tier0/tier2/tier3/housekeeping), deriveTask for parent-child chains
  - `drainer.ts` — quota-based consumption (tier0:3, tier2:5, tier3:1), mutex guard, IdleGate integration, kind-based dispatchers
  - `triggers.ts` — 5 trigger types: IdleTrigger (idle 30s), EventTrigger (main_loop_settled+1s), CronTriggers (*/15min, daily, weekly), ThresholdTrigger, ManualTrigger. Each with allowedKinds filtering.
  - `cron-scheduler.ts` — Cron-based scheduled tasks
- **Defense**:
  - `idle-gate.ts` — blocks review while streaming/compacting
  - `review-slot.ts` — single pending slot with priority override
  - `review-backoff.ts` — exponential backoff 30s→15min with jitter
  - `circuit-breaker.ts` — global circuit breaker (3 failures → 1h pause)
  - `tier-breaker.ts` — per-tier circuit breaker with independent thresholds and cooldowns
- **Runner & Supervisor**:
  - `review-runner.ts` — TaskRunner with RunnerOutcome + configurable hard abort timeout
  - `supervisor.ts` — cancelPolicy dispatch (preempt/graceful/finish) per task kind
  - `settle-bus.ts` — event bus (main_loop_settled, task_completed, idle_window_open, cron_fired)
- **Other**:
  - `prompt-templates.ts` — Review prompt templates
  - `types.ts` — ReviewConfig, EvolutionCallback, SkillStats, SkillStatus

### Built-in Tools (`/src/tools/`)

- `bash.ts`: BashTool — execute shell commands with working directory bounds
- `text-editor.ts`: TextEditorTool — file editing with string replacements
- `read.ts`: ReadTool — read files from filesystem
- `grep.ts`: GrepTool — content search across files
- `glob.ts`: GlobTool — file pattern matching
- `ls.ts`: LsTool — list directory contents
- `web-search.ts`: WebSearchTool — web search via Tavily API
- `ask-user-question.ts`: AskUserQuestionTool — interactive multiple-choice prompts
- `ask-user-question-manager.ts`: Manager for active user questions
- `memory.ts`: MemoryTool re-export for manual memory operations
- `permission-manager.ts`: Permission state management
- `zod-tool.ts`: Base class for Zod-validated tools
- `index.ts`: Tool exports

### Task Management (`/src/todos/`)

- `todo-middleware.ts`: createTodoMiddleware — TodoWriteTool + hooks
- `types.ts`: Todo type definitions
- `index.ts`: Module exports

### Session Management (`/src/session/`)

- `store.ts`: SessionStore — persistent session files in ~/.my-agent/sessions/
- `hook.ts`: createAutoSaveHook — afterAgentRun persistence

### Utilities (`/src/utils/`)

- `debug.ts`: Debug logging utilities (debugLog)
- `hash.ts`: Hashing utilities
- `is-text-file.ts`: Binary/text file detection

### Terminal UI (`/src/cli/tui/`)

- `index.tsx`: TUI main export
- `App.tsx`: Root Ink/React application container
- `command-registry.ts`: Slash command types, filtering, and matching utilities
- `types.ts`: TUI type definitions
- **State** (`state/`):
  - `store.ts`: Zustand store for TUI state
  - `types.ts`: TUI state type definitions
  - `selectors.ts`: State selectors
  - `message-converter.ts`: Converts agent events to UI messages
- **Streaming** (`streaming/`):
  - `committer.ts`: Streaming output commit logic
- **Markdown** (`markdown/`):
  - `parse-ast.ts`: Markdown AST parsing
  - `render-ast.tsx`: AST to React rendering
  - `render-table.tsx`: Table rendering
  - `cache.ts`: Render cache
- **Views — Chrome** (`views/chrome/`):
  - `Header.tsx`: Application header with logo
  - `Footer.tsx`: Status footer
  - `InputBox.tsx`: User input with autocomplete
  - `StreamingIndicator.tsx`: Streaming animation indicator
  - `keymap.ts`: Keyboard shortcut definitions
- **Views — Active** (`views/active/`):
  - `ActiveAssistantView.tsx`: Live streaming assistant output
  - `LiveTextSegment.tsx`: Live text rendering segment
- **Views — Final** (`views/final/`):
  - `AssistantMessageView.tsx`: Finalized assistant message
  - `AssistantHeaderView.tsx`: Assistant message header
  - `AssistantTailView.tsx`: Assistant message footer
  - `ToolCallFinalView.tsx`: Completed tool call display
  - `FinalToolCallView.tsx`: Final tool call rendering
  - `UserMessageView.tsx`: User message display
  - `SystemNoticeView.tsx`: System notification display
  - `CommittedBlockView.tsx`: Committed text block view
  - `FinalItemView.tsx`: Generic final item wrapper
  - `DividerView.tsx`: Visual divider
  - `MarkdownText.tsx`: Rendered markdown text
- **Views — Overlay** (`views/overlay/`):
  - `AskUserQuestionPrompt.tsx`: Modal for user questions
  - `PermissionPrompt.tsx`: Permission request modal
  - `FocusedToolDetail.tsx`: Detailed tool call view
- **Components** (`components/`):
  - `HighlightedInput.tsx`: Input display with cursor position highlighting
  - `CommandList.tsx`: Autocomplete dropdown for slash commands
  - `FilePicker.tsx`: File path picker
  - `CodeBlock.tsx`: Syntax-highlighted code blocks
  - `ReviewNotification.tsx`: Evolution review notification
  - `utils/language-map.ts`: Prism language mapping
  - `utils/tokenize-by-line.ts`: Line-based tokenization
  - `utils/prism-theme.ts`: Prism syntax highlighting theme
- **Commands** (`commands/`):
  - `session-commands.ts`: Session-related commands (tasks, memory, etc.)
  - `compact-command.ts`: Manual context compression trigger
  - `mcp-commands.ts`: MCP server management commands
  - `review-commands.ts`: Evolution review commands
  - `diagnostic-commands.ts`: Diagnostic and debug commands
- **Hooks** (`hooks/`):
  - `use-agent-subscription.ts`: Agent event stream subscription
  - `use-command-input.ts`: Main input hook with autocomplete and history
  - `use-input-editor.ts`: Pure editor state transformation functions
  - `use-input-history.ts`: Persistent input history browsing
  - `use-ask-user-question-manager.ts`: Hook for managing active questions
  - `use-permission-manager.ts`: Hook for permission state
  - `paste-handler.ts`: Paste event handling
  - `use-bracketed-paste.ts`: Bracketed paste mode support
- **Other TUI files**:
  - `paste-buffering-stdin.ts`: Stdin paste buffering
  - `paste-attachments.ts`: Paste attachment support
  - `utils/tool-format.ts`: Tool output formatting
  - `utils/render-markdown.tsx`: Markdown rendering utilities
  - `utils/syntax-cache.ts`: Syntax highlighting cache

### Binaries (`/bin/`)

- `my-agent.ts`: Headless CLI entry point (parses args → createAgentRuntime → agent loop)
- `my-agent-tui-dev.ts`: Development entry point for TUI (runs TypeScript directly with Bun)
- `my-agent-tui`: Production entry point (Bun-compiled binary)
- `mcp-cli.ts`: MCP server management sub-CLI (list/add/remove MCP servers in settings.json)

### Scripts (`/scripts/`)

- `check-architecture.ts`: Architecture constitution enforcement (CI check)
- `pre-edit-guard.ts`: Pre-edit safety checks
- `update-any-baseline.ts`: any baseline updater
- `git-hooks/pre-push`: Git pre-push hook

## Important Files

- `tsconfig.json`: TypeScript configuration
- `package.json`: Project dependencies and scripts
- `CLAUDE.md`: This file — project guidance for Claude Code
- `ARCHITECTURE-CONSTITUTION.md`: Mandatory non-negotiable architecture rules
- `DESIGN.md`: Comprehensive architecture design document (73KB)
- `README.md`: Project documentation
- `skills/`: Directory containing available skills (each in separate folder with SKILL.md)
- `tests/`: Test suite (unit and integration tests for all modules)
- `bin/`: Executable scripts
- `scripts/`: Build/CI utility scripts

## Getting Started

When adding code to this repository:
1. Understand the project requirements and architecture
2. Read and comply with the [Architecture Constitution](./ARCHITECTURE-CONSTITUTION.md)
3. Update this file with relevant commands and architecture documentation as the project takes shape
