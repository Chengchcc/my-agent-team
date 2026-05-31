# CLAUDE.md

> Project guide for AI coding assistants (Claude / Cursor / Copilot agents) and human contributors. Read this whole file before opening a PR.

---

## ⚠️ ARCHITECTURE CONSTITUTION — MANDATORY READ FIRST

**All code in this repository must comply with the [Architecture Constitution](./ARCHITECTURE-CONSTITUTION.md).**

These are non-negotiable, CI-enforced rules. Violations will block your PR. Read the full constitution **before writing any code**.

**Summary of violations that will block your code:**

- Instantiating core objects directly in `bin/*` (use `createKernel()` + extension presets).
- Adding new `any` types or unsafe casts.
- Using `console.log` instead of `ctx.logger` / `debugLog`.
- Unannotated `@ts-ignore` / `@ts-expect-error`.
- Files > 400 lines or functions > 80 lines without justification.
- New public APIs without unit tests.
- Defining public data contracts outside `src/application/contracts/**`.
- Importing `extensions/**` from `application/ports/**`, `application/slash/**`, or `infrastructure/transport/**`.
- Using `zod` outside `src/application/contracts/**` (`src/infrastructure/config/schema.ts` is the only exemption).

---

## 🎨 Design Philosophy — Read Before Designing New Features

**Before writing any code for a new feature, read the [Design Philosophy](./DESIGN-PHILOSOPHY.md).**

Core patterns at a glance:

- **Kernel + Extensions assembly** — wire in `createKernel()` + extension presets, never in `bin/*`.
- **Hook-based extensibility** — cross-cutting concerns use the **12-hook** system, not new classes.
- **Slash commands are application-level** — built-ins live in `application/slash/`, extensions contribute via the `slash` channel.
- **Everything is a tool** — the LLM only knows `function_call`, so every capability is a tool.
- **Discriminated unions** — `switch(event.type)` with exhaustive `never`, never cast.
- **Progressive disclosure** — metadata eagerly, full content on demand.
- **Least-destructive-first** — graduated response, never "fine" → "nuclear".
- **Zod at boundaries** — parse, don't validate; schema derives the type. Zod is restricted to `application/contracts/`.
- **Ports / Adapters** — `application/ports/` define interfaces, `infrastructure/` implements them.
- **Contracts own cross-boundary data** — `application/contracts/` has type sovereignty for events, records, envelopes.

---

## Design Overview

For a comprehensive walkthrough — kernel boot sequence, extension system, event bus, tool dispatch, memory, skills, compaction, TUI, and how everything fits together — read the **[Design Document](./DESIGN.md)**.

> Note: `DESIGN.md` is currently mid-rewrite to align with Lobster v2.0. Where `DESIGN.md` and `ARCHITECTURE-CONSTITUTION.md` disagree, the constitution wins.

---

## Current State

This is a TypeScript-based AI agent framework built with Bun. The system has completed its major refactor from a monolithic `Agent` class to a **kernel + extension** architecture (Lobster v2.0). The kernel manages an event bus, hook dispatch, RPC registry, and extension lifecycle. All subsystems (provider, memory, session, tools, trace, evolution, MCP, skills, permission, identity, controlplane, dataplane, transport, frontends) are extensions that plug into the kernel.

**Refactor status (M1, branch `feature/lobster-m1-kernel`):**

- P-1 … P-5 complete.
- Slash-promotion epic complete (built-ins in `application/slash/`, `slash` channel on extensions). **Frontend wiring of `collectSlashCommands()` is the open P0 — extension-contributed slashes are silently absent at M1 cut.**
- `src/types.ts` and `src/core/` no longer exist; their contents moved to `application/contracts/` and per-extension contract folders.

---

## Development Commands

- **Compile TypeScript**: `bun run tsc` (alias: `bun run build`)
- **Run TUI**: `bun run tui` (alias: `bun run dev`)
- **Run headless agent**: `bun run agent` (alias: `bun run headless`)
- **Run tests**: `bun test`
- **Lint**: `bun run lint`
- **Type check only**: `bun run check:guard`
- **Architecture check**: `bun run check:arch`
- **Dead code check**: `bun run check:deadcode`
- **Full CI check**: `bun run check:all` (typecheck + tests + arch + deadcode)
- **Update `any` baseline**: `bun run baseline:any`
- **Install git hooks**: `bun run prepare`

> `bun run check:deadcode` runs `knip`. Note that knip v5 silently ignores invalid schema keys with exit 0 — when changing `knip.json`, always inspect the issue table, not just the exit code.

---

## Architecture

### Kernel (`/src/kernel/`)

The kernel is the extension system core — a minimal DI container.

- `define-extension.ts`: `defineExtension({ name, enforce?, dependsOn?, apply })` — extension registration factory. The `apply(ctx)` return shape is `{ provide, hooks, subscribe, rpc, slash, dispose }`.
- `kernel-context.ts`: `KernelContext` — context passed to `apply()`. Frozen surface:
  `{ agentId, paths, extensions, bus, hooks, rpc, clock, logger, config }`. `agentDir` is `@deprecated` — read `paths.agentDir`. There is no `profileId` / `profileDir`.
- `kernel.ts`: `createKernel(opts)` topo-sorts extensions, calls `apply()` in dependency order, dispatches `configureKernel` then `kernelReady`.
- `event-bus.ts`: `EventBus` — pub/sub with failure isolation.
- `extension-registry.ts`: `ExtensionRegistry` — capability lookup `ctx.extensions.get('name.cap')`. Also exposes `collectSlashCommands()` for frontends.
- `hook-container.ts`: `HookContainer` — **12 hooks**, **3 dispatch modes** (`sequential`, `parallel`, `first-match`).
- `topo-sort.ts`: Kahn's algorithm topological sort by `dependsOn` + `enforce` phase.
- `rpc-registry.ts`: O(1) JSON-RPC method dispatch.

### Application Layer (`/src/application/`)

- **Contracts (`contracts/`)** — single source of truth for all cross-boundary data. Owns event types, envelopes, codecs, history record schema. Uses zod (restricted to this directory). Key exports: `EventEnvelope`, `createEvent()`, `DataPlaneEvent` + `DataPlaneEventType` union (closed list in `dataplane-event.ts`), `ContentBlock`, `HistoryRecordV1` + `parseHistoryLine()`, `JsonRpcMessage` + helpers, plus typed event contracts for provider, memory, evolution, session, tool, permission, identity, widget events — each with Zod codecs.
- **Ports (`ports/`)** — abstract interfaces (anti-corruption layer). `Transport`, `ProviderChat` / `ProviderInvoke`, `Logger`, `ToolContext`, `MemoryStore`, `SessionStore`, `TraceWriter` / `TraceReader`, `JobSpawner`, `ProposalStore`, `SkillStatsStore`, etc. Ports depend on contracts, never on extensions.
- **Slash (`slash/`)** — slash command primitive (post-promotion epic). `SlashRegistry`, `SlashCommand`, `SlashContext`, built-ins under `slash/builtin/`, helpers (`filterCommands`, `getBestCompletion`, …), and `registerBuiltinSlashCommands(registry, opts?)`.
- **Usecases (`usecases/`)** — pure orchestration, no I/O. `runTurnUsecase`, `buildRunTurnDeps`, `appendHistory`, `submitTurn` / `buildTurnMessages`, `resolveTools`, `transformPrompt`.

### Domain (`/src/domain/`)

Pure domain entities: `Session`, `Turn`, `TurnEvent` (discriminated union), `TraceEvent`, `MemoryEntry`, `Identity` / `IdentityDiff`, `SkillDescriptor`, `Agent`. `turn-runner.ts` is an async generator yielding `TurnEvent` variants.

### Extensions (`/src/extensions/`)

**18 extensions**, each a `defineExtension()` call. Key ones:

| Extension | enforce | Capabilities | Notable hooks / channels |
|---|---|---|---|
| `trace` | pre | `trace.writer/reader` | `onTraceEmit`, `onShutdown` |
| `provider` | pre | `provider.llm` | `kernelReady`, `onLLMDelta` |
| `session` | normal | `session.store/history` | `kernelReady`, `onTurnStart/End` |
| `tools` | normal | `tools.registry` | `resolveTools`, `onToolCall` |
| `tool-catalog` | normal | tool catalog | `resolveTools` |
| `permission` | pre | `permission.checker` | `onToolCall` |
| `controlplane` | post | `controlplane.server` | `kernelReady`, `onShutdown` |
| `dataplane` | post | `dataplane.stream` | bus subscriptions |
| `memory` | normal | `memory.store` | `transformPrompt`, `onTurnEnd`, `slash` |
| `identity` | normal | `identity.store` | `transformPrompt`, `onIdentityChanged` |
| `skills` | normal | `skills.registry` | `kernelReady`, `resolveTools` |
| `evolution` | normal | review pipeline | `kernelReady`, `onShutdown`, `slash` |
| `mcp` | normal | `mcp.manager` | `kernelReady`, `resolveTools`, `onShutdown` |
| `infra-services` | pre | spawner / proposal store / skill stats | — |
| `transport.inmem` | post | transport | — |
| `transport.unix` | post | transport | `kernelReady`, `onShutdown` |
| `frontend.tui` | post | TUI adapter | — |
| `frontend.lark` | post | Lark bot adapter | `kernelReady`, `onShutdown` |

Extensions communicate via `ctx.bus` (events), `ctx.extensions.get()` (capabilities through ports), `ctx.hooks.dispatch()` (hooks), and `ctx.rpc` (JSON-RPC methods).

- `presets.ts`: Named preset bundles for different scenarios (TUI, headless, daemon).

### Event Flow

```
Extension emit on bus → DataPlane bridges to DataPlaneEvent (cursor + evId)
  → emits 'dataplane.event' → Transport forwards to FrontendHandle.onAgentEvent()
```

All cross-boundary events are wrapped in `EventEnvelope` via `createEvent(type, payload, opts?)`. The full set of `DataPlaneEventType` values lives in `application/contracts/dataplane-event.ts`.

### Infrastructure (`/src/infrastructure/`)

Adapter implementations organized by domain: `llm/` (ClaudeProvider, OpenAiProvider, EchoProvider, adapters), `transport/` (InMemoryTransport, UnixSocketTransport), `trace/`, `session/`, `memory/` (SqliteMemoryAdapter), `identity/`, `logging/`, `paths/` (`AgentPaths`), `config/`.

### Configuration (`/src/infrastructure/config/`)

`types.ts`, `schema.ts` (Zod, exempt from the application/contracts zod restriction), `defaults.ts`, `loader.ts` (YAML/JSON), `constants.ts`, `migrations.ts`, `index.ts`.

**Memory embedding encoder**: Defaults to Ollama (`localhost:11434`). Override via `memory({ encoder })` preset injection, `agent.yaml` `memory.embedding.*` keys, or env vars `MY_AGENT_MEMORY_EMBED_BASE_URL` / `MY_AGENT_MEMORY_EMBED_MODEL` / `MY_AGENT_MEMORY_EMBED_TIMEOUT_MS`. E2E fixtures assemble `fakeEncoder` — E2E must never touch the network.

### Terminal UI (`/src/extensions/frontend.tui/`)

Ink/React TUI implementing `FrontendHandle`. TUIAdapter wraps Transport, bridges `DataPlaneEvent` → view-model events. Zustand store with live / committed streaming state. Views organized by rendering lifecycle: `views/chrome/`, `views/active/`, `views/final/`, `overlays/`, `panels/`. Hooks: `use-agent-subscription`, `use-command-input`, `use-permission-manager`, `use-session-picker`.

### Binaries (`/bin/`)

Thin CLI entry points — parse args → assemble kernel → run:

- `my-agent-cli.ts`: CLI dispatch (subcommand router).
- `my-agent-daemon.ts`: Daemon process entry.

### Scripts (`/scripts/`)

- `check-architecture.ts`: Architecture constitution enforcement (CI check, ts-morph based).
- `check-apply-pure.ts`: Extension `apply()` purity check.
- `assert-cli-bearing.ts`: Compile-time check that CLI-bearing extensions export `cliManifest`.
- `update-any-baseline.ts`: `any` baseline updater.
- `git-hooks/pre-push`: Git pre-push hook.

---

## Important Files

- `tsconfig.json`: TypeScript configuration.
- `package.json`: Project dependencies and scripts.
- `knip.json`: Dead-code config (note: knip v5 silently ignores invalid keys).
- `eslint.config.js`: Layering and slash-domain guards.
- `CLAUDE.md`: This file.
- `ARCHITECTURE-CONSTITUTION.md`: Mandatory non-negotiable architecture rules.
- `DESIGN-PHILOSOPHY.md`: Design principles and recurring patterns.
- `DESIGN.md`: Comprehensive architecture design document.
- `README.md` / `README.en.md`: User-facing documentation.
- `skills/`: Available skills (each with `SKILL.md`).
- `tests/`: Test suite.

---

## CLI-bearing Extensions

When you modify any of these extensions, you MUST also:

1. Verify `export const cliManifest: CliManifest` is present in `index.ts`.
2. Verify the `_CheckCliManifest` compile-time assertion exists (it can carry an `@internal` JSDoc tag for knip).
3. If adding a new RPC method, expose it via `cliManifest.handler`.
4. If renaming the extension, update `CLI_BEARING_EXTS_TARGET` in `scripts/check-architecture.ts` AND the import in `src/cli/cli-registry.ts`.

| Ext | Subcommand | `cliManifest` location |
|---|---|---|
| trace | `my-agent trace ...` | `src/extensions/trace/index.ts` |
| memory | `my-agent memory ...` | `src/extensions/memory/index.ts` |
| skills | `my-agent skills ...` | `src/extensions/skills/index.ts` |
| evolution | `my-agent evolution ...` | `src/extensions/evolution/index.ts` |
| mcp | `my-agent mcp ...` | `src/extensions/mcp/index.ts` |

---

## Getting Started

When adding code to this repository:

1. Read and comply with the [Architecture Constitution](./ARCHITECTURE-CONSTITUTION.md).
2. Read the [Design Philosophy](./DESIGN-PHILOSOPHY.md) for patterns to follow.
3. New cross-boundary data types go in `src/application/contracts/`.
4. New abstractions go in `src/application/ports/`.
5. New side-effect-free orchestration goes in `src/application/usecases/`.
6. New extension capabilities use `defineExtension()` with proper `enforce` ordering.
7. New adapter implementations go in `src/infrastructure/`.
8. New slash commands: built-ins in `src/application/slash/builtin/`; extension-owned via the extension's `slash` channel.
9. Update this file as the project evolves.
