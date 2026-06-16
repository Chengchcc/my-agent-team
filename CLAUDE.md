# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                # Install dependencies (bun lockfile)
bun run format             # Biome format
bun run lint               # Biome check + ESLint
bun run typecheck          # tsc --noEmit across all packages (via turbo)
bun run test               # Run all tests (via turbo)
bun run build              # tsc build to dist/ (via turbo)
bun run create             # Interactive new-package scaffold
```

Each package also has its own `build`, `lint`, `test`, `typecheck` scripts. Run a single package test:

```bash
cd packages/framework && bun test
```

Filter to a single test file or pattern:

```bash
cd packages/framework && bun test --test-name-pattern="createAgent"
```

## Architecture (6-layer agent stack)

```
L6 Surfaces     Frontend web / IM bot — talk HTTP/SSE to backend (planned M13+)
L5 Backend      Multi-agent service (HTTP/SSE, auth, tenancy, runner pool) — planned M8
L4 Harness      Opinionated product layer: built-in tools + system prompt + policy
L3 Framework    createAgent() — composes model + tools + plugins + checkpointer + contextManager
L2 Runtime      run() async generator — messages → model stream → tool execute → loop
L1 Protocols    Type contracts: Message / ChatModel / Tool / ContentBlock
```

Vision and milestone roadmap: see `docs/architecture/00-vision.md`.

Package map:

| Package | Layer | Exports |
|---------|-------|---------|
| `@my-agent-team/core` | L1+L2 | `Message`, `ChatModel`, `Tool`, `run()`, `collectStream()` |
| `@my-agent-team/framework` | L3 | `createAgent()`, `definePlugin()`, `pipeContextManagers()`, `InterruptSignal`, checkpointer impls |
| `@my-agent-team/adapter-anthropic` | adapter | `AnthropicChatModel` (implements `ChatModel`) |
| `@my-agent-team/agent-spec` | wire | `AgentSpecV1`, `AgentSpec`, `CURRENT_SCHEMA_VERSION` — backend ↔ runner contract |
| `@my-agent-team/runner-stdio` | wire | `runEntry()`, `my-agent-runner` bin — stdio subprocess runner entry |
| `@my-agent-team/tools-common` | tools | `createReadToolForWorkspace`, `createWriteToolForWorkspace`, `createEditToolForWorkspace`, `bashTool`, `grepTool`, `globTool`, `webFetchTool`, `createWebSearchTool`, `withWorkspace`, `SandboxError`, `AgentFsLike` |
| `@my-agent-team/test-helpers` | test | `echoModel()` — deterministic test double for `ChatModel` |
| `@my-agent-team/plugin-fs-memory` | plugin | `fsMemoryPlugin()` — file-backed memory with beforeModel bootstrap injection |
| `@my-agent-team/plugin-progressive-skill` | plugin | `progressiveSkillPlugin()` — SKILL.md index injected into system prompt, full body loaded on demand via tool |

## Key patterns

**ChatModel is the only integration point.** Core has no LLM dependency. `ChatModel.stream(messages, opts) → AsyncIterable<AIMessageChunk>` is the contract. The Anthropic adapter translates between this contract and the Anthropic SDK. Tests swap in `echoModel()` or inline `ChatModel` implementations.

**Plugin system (framework L3).** Plugins contribute tools (static `tools` field) AND hooks. Four hook points, all fire in plugin registration order:
- `beforeModel(ctx, messages) → messages` — mutate context before model call (inject system prompt content, etc.)
- `afterModel(ctx, messages)` — observe model output
- `beforeTool(ctx, call, messages)` — intercept tool calls; can skip execution or rewrite input
- `afterTool(ctx, call, result, messages)` — observe tool results

Tool name collisions between plugins (or between plugin tools and `config.tools`) throw at agent creation time.

**ContextManager pipeline.** `pipeContextManagers(...)` chains multiple context managers. Each `shape()` receives the output of the previous one. Built-in: `passthrough`, `slidingWindow`, `summarizing`, `tokenBudget`, `toolResultTruncator`.

**Checkpointer + Interrupt.** A `Checkpointer` persists message history and optional event log. `InterruptSignal` thrown from a tool's `execute()` pauses the agent; call `agent.resume({ approved: true/false })` to continue. Must use a checkpointer that implements both `saveInterrupt` + `consumeInterrupt`.

**Testing.** Tests use `bun:test` (`describe`/`test`/`expect`). Tests live beside source files (`*.test.ts`). Pattern: define a scripted `ChatModel` that yields predetermined turns, build an agent/run with it, collect the async iterable, assert on yielded messages. `@my-agent-team/test-helpers` exports `echoModel()` which does the same.

## Cross-cutting rules

- **No deep imports.** Cross-package imports must go through the package's `index.ts` (re-export barrel). Enforced by convention, not tooling.
- **Design principles.** First principles, Occam's razor, Pareto. No protocol fields without proven need. Composition over framework hooks.
- **TypeScript.** ESM with `NodeNext` module resolution. Target ES2023. Strict mode + `noUncheckedIndexedAccess` + `noUncheckedSideEffectImports`.
- **Git commits.** Author: chengchen. No Co-Authored-By trailers.
