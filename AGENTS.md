# Agent Principles

## Implementation Principles

**Long-termism.** Make decisions that minimize integral cost over time, not instantaneous cost at the current moment. A shortcut today creates path-dependency and future correction cost; a one-time structural investment preserves decision-space freedom. Optimize for the trajectory, not the point.

**Elegance first.** Elegance is the minimum-entropy solution given the current information level and long-term objective. Prefer simple, practical implementations without over-engineering. An elegant solution sits at the low point of the characteristic surface at constant information — no less, no more.

## Thinking Principles

**First principles.** Reject empiricism and path-following. Do not assume the user is fully clear on their goal — stay vigilant, start from raw requirements and the problem itself. If the goal is ambiguous, pause and discuss with the user. If the goal is clear but the path is suboptimal, directly propose a shorter, lower-cost alternative.

**Challenge implicit assumptions.** Identify hidden premises in user questions. If a premise is wrong, correct it before answering. Use numbers over adjectives. Give definitive judgments over hedged positions.

### Response Structure

Every response has two parts:
- **Direct execution.** Execute the task as requested, following the user's current logic.
- **Deep interaction** (when applicable). Challenge the user's intent against first principles: question whether motives deviate from the goal (XY problem), expose hidden costs or downsides of the current path, offer more elegant alternatives. If derivation requires missing data, state what's needed rather than obscure uncertainty with vague language.

### Relationship with the User

- Your loyalty is to **truth**, not to the user's expectations.
- Challenge the user's views with respect but without retreat — gently insist, don't politely obscure.
- If the user presents better facts or reasoning, correct your conclusion immediately without pointless defense.
- Cross-reference `docs/architecture/design-philosophy.md` when making design decisions.

# Repository Guidelines
## Project Overview

`my-agent-team` is a monorepo for building multi-agent AI systems. It spans from a protocol-level agent runtime (`packages/message`, `apps/oh-my-agent/src/core`) through a production backend (`apps/backend`) and web UI (`apps/web`), plus a Agentic Workflow engine.

**Tech stack:** Bun 1.3.14 runtime, TypeScript 6.x (ESM, `NodeNext`), Turborepo v2, Elysia HTTP, Drizzle ORM + SQLite, Next.js 15 App Router, React Query v5, shadcn/ui + Tailwind CSS v4, Biome + ESLint.

## Architecture & Data Flow

```
Surfaces        Web app / Lark bot / oma TUI - talk HTTP/SSE to the backend
Backend         Product facts + execution control plane (apps/backend)
Adapter         packages/adapter-* - child process boundary (spawn / JSONL / steer / stop / approval)
Runtime         apps/oh-my-agent/src/core - model+tool loop, plugins, compaction, todo
Protocols       Message / ChatModel / Tool / ContentBlock / WorkflowDefinition (packages/{message,agent-contract,api-contract,workflow})
```

The current-state description of each layer lives in the wiki: start at
[`docs/architecture/README.md`](docs/architecture/README.md).

**Package dependency graph** (`audit:workspace` fails if a workspace member is
missing from this list; `@chengchenccc/` is the scope of every name below):
- Leaves (no workspace deps): `@chengchenccc/message`, `@chengchenccc/config`, `@chengchenccc/tui`, `@chengchenccc/sandbox`, `@chengchenccc/source-fetch`, `@chengchenccc/workflow`
- Contracts: `@chengchenccc/agent-contract` (spawn-neutral `AgentBackend`), `@chengchenccc/api-contract` (HTTP `App` + SSE event maps — the web↔backend wire, type-only)
- Adapters (child-process boundary): `@chengchenccc/adapter-oma-agent`, `@chengchenccc/adapter-claude-agent`, `@chengchenccc/adapter-pi-agent`, `@chengchenccc/adapter-omp-agent` (the 4 implement `AgentBackend`), `@chengchenccc/adapter-mcp` (MCP client mount — not an `AgentBackend`)
- Runtime support: `@chengchenccc/ai` (provider + model registry; `createProvider` over the three protocol implementations), `@chengchenccc/test-helpers` (`echoModel()`)
- Plugins: 0 plugins as standalone packages; oma-native todo/progressive-skill live in `apps/oh-my-agent/src/core`
- Apps: `@chengchenccc/backend` (consumes all), `@chengchenccc/oh-my-agent` (oma CLI + runtime), `@chengchenccc/web` (Next.js), `@chengchenccc/lark-bot`

**Data flow:** Backend is the single truth source. Frontend uses Eden Treaty typed client to call BFF proxy (`/api/bff/[...path]`) which forwards to backend with auth headers. SSE events from backend flow through Next.js BFF to React Query subscriptions.

## Key Directories

| Directory | Purpose |
|---|---|
| `packages/message/` | Protocol layer: Message/MessageRevision + ChatModel/Tool/AIMessageChunk + stream utils (absorbed the former core package) |
| `apps/oh-my-agent/src/core/` | Oma runtime: `createOmaSession()` (agent-loop), plugins, compaction, persistence (absorbed the former agent package) |
| `apps/backend/src/features/workflow/` | Agentic Workflow DSL engine: triggers, executions, human tasks |
| `packages/ai/` | Provider + model registry, protocol implementations, model metadata |
| `packages/workflow/` | Agentic Workflow DSL pure domain: node graph, JSON-Logic routing, computeNext engine |
| `packages/sandbox/` | Process sandbox for workflow script nodes + oma eval tool |
| `packages/test-helpers/` | `echoModel()` for deterministic test doubles |
| `apps/oh-my-agent/src/core/tools/` | Oma-native tools: read/write/edit/bash/grep/glob/web/eval + MCP mount |
| `apps/backend/` | Elysia server: all services, routes, workflow trigger scheduling |
| `apps/web/` | Next.js 15 App Router: agents, conversations, workflow, ops, skill-packs |
| `apps/lark-bot/` | Lark/Feishu IM bot integration |
| `apps/oh-my-agent/` | Oma CLI agent runtime (spawned `--mode rpc` by backend adapters) |
| `skills/` | Skill packs (SKILL.md + registry.yaml) for agent runtime |
| `docs/` | Project wiki: `architecture/` (current state), `adr/` (decisions), `guides/` (how-to), `roadmap.md` (not done yet) |

## Development Commands

```bash
bun install                    # Install dependencies
bun run build                  # Build all packages (turbo)
bun run dev                    # Start dev servers
bun run format                 # Biome format all files
bun run lint                   # Biome check + ESLint
bun run typecheck              # tsc --noEmit across all packages (turbo)
bun run test                   # Run all tests (turbo)
bun test                       # Run tests at root
bun run audit                  # contracts + workspace + docs + ui gates (fast)
bun run audit:coverage         # focused coverage floors for the oma runtime (~60s)
bun run quality:mutate         # mutation probe: does the suite FAIL when behaviour breaks?

# Scoped commands:
cd apps/oh-my-agent && bun test --test-name-pattern="agent-loop"
cd apps/backend && bun run typecheck
```

**Testing gates.** `bun run audit:coverage` enforces per-directory averages plus
per-file floors for the files that carry runtime semantics (loop, permissions,
protocol, file/bash tools, session). `bun run quality:mutate` breaks one
behaviour at a time in the source, runs the real suite, and reports which
mutations survive — a survivor is an untested claim, not a passing feature. Use
it after touching a security boundary or a lifecycle rule; it costs one full
suite per mutation, so it is on-demand rather than a CI gate.

**Per-package scripts:** Every package has `build`, `typecheck`, `test` scripts (lint coverage varies by package).

## Code Conventions & Common Patterns

### Imports: No deep imports
Cross-package imports MUST go through the barrel (`index.ts`). `import { parseWorkflow } from "@chengchenccc/workflow"` not `"@chengchenccc/workflow/src/parse.js"`. Enforced by ESLint `consistent-type-imports`.

### Dependency Injection
Backend uses **composition-root DI** (no framework): `src/bootstrap/features.ts` assembles ports, services and backends, `src/bootstrap/services.ts` builds process-level infrastructure, and `main.ts` only orders startup and signals. Feature routes never construct their own collaborators. Most features follow the same shape:

```
domain.ts          — Pure types, entity interfaces
ports.ts           — Storage boundary interface
service.ts         — Business logic (factory pattern: `createXxxService(deps)`)
adapter-sqlite.ts  — Drizzle ORM implementation
http.ts            — Elysia routes
index.ts           — Barrel re-exports
```

### Agent Session Creation
`createOmaSession(opts)` in `apps/oh-my-agent/src/core/runtime/agent-loop.ts` materializes an Oma session. The option type is `OmaSessionOptions` (`core/runtime/agent-loop-types.ts`); required are `sessionId`, `store`, `maxSteps`, `maxForceContinues`, `modelStream` and `summarize`, and per-run tools arrive through `resolveTools` rather than a `tools` array.

Run-level assembly goes through `createOmaRuntime(options)` in `core/runtime/create-runtime.ts`, which `run-runtime.ts` extends into `RunRuntimeDeps`. Do not hand-build a session to model a Run.

Backend dispatch is `apps/backend/src/features/agent-run/execution-dispatch.ts`: it enqueues inputs, spawns the child through the adapter for the run's backend kind, and commits canonical messages via the conversation ledger.

### Plugin System
Plugins are plain objects `{ name, hooks?, tools?, meta? }` contributing tools, lifecycle hooks, and meta sections (see `Plugin` in `apps/oh-my-agent/src/core/runtime/plugin.ts`):
```typescript
interface PluginHooks {
  beforeRun?(messages, rt): void;
  afterRun?(status, messages, rt): void | Promise<void>;
  beforeModel?(messages, rt): readonly Message[];
  afterModel?(messages, rt): void;
  beforeTool?(toolName, input, rt): { block?, reason? } | undefined;
  afterTool?(toolName, result, rt): OmaLoopEvent | { content?, isError?, terminate? } | undefined;
  transformToolArgs?(toolName, input, rt): unknown;
  beforeStop?(cancel, rt): void;
  afterStop?(vetoed, rt): void;
}
```

`validatePlugins()` checks name/tool collisions; `collectTools()` and `renderMeta()` assemble the per-run tool table and meta sections.

### ChatModel is the only integration point
Core has no LLM dependency. `ChatModel.stream(messages, opts?) → AsyncIterable<AIMessageChunk>` is the contract. Tests use `echoModel()` from `@chengchenccc/test-helpers`.

### Workflow System
Two layers: **packages/workflow** (pure domain: `WorkflowDefinition` DSL, `computeNext` engine, JSON-Logic routing, schema validation) + **apps/backend/src/features/workflow** (executions, node runs, human forms, trigger scheduler, SSE live stream).

- Node types: `start` / `end` / `agent` (dispatches an Agent Run; outputSchema-constrained) / `script` (runs in `@chengchenccc/sandbox`) / `human` (`waiting_human` + web form)
- Routing is frozen into `CompletionRecord.routedTo` at node completion — never recomputed; join semantics = any-of
- Triggers: cron via Bun.cron trigger-scheduler over `workflows/*.workflow.json`

### File Naming
- Source: `*.ts`, tests: `*.test.ts` (beside source, no `__tests__` dirs)
- Feature features: `domain.ts`, `ports.ts`, `service.ts`, `adapter-sqlite.ts`, `http.ts`, `index.ts`
- Barrel files: every package/feature has `index.ts` re-exporting public API

### Error Handling
- Backend: Elysia `.onError` handler translates `HttpError` + `NOT_FOUND` to JSON
- Service layer: throw typed errors (`ProjectNotFoundError`, `ValidationError`)
- Workflow: node failures are captured per node-run; the execution terminalizes as failure (cancel unwinds the drive loop)
- Agent: `permissionMode="ask"` tools go through the approval pipeline (`approval_request` event → `resolve_approval`; timeout denies)

### Web UI: use the component library, never native controls
In `apps/web`, reach for `@/components/ui/*` before a raw HTML element:
- Buttons → `Button` (`@/components/ui/button`); icon-only actions get a
  `Tooltip`/`title` and `variant="ghost" size="icon"`.
- Selects → `Select` (`@/components/ui/select`), never a native `<select>`.
- Inputs → `Input` / `Textarea`; dialogs → `Dialog` / `AlertDialog`;
  destructive confirmations → `useConfirm()` + `variant="destructive"`
  (never `window.confirm`).
- Exemptions (documented, not precedent): canvas/toolbar overlay controls
  and segmented/tab controls where a native element is semantically right.
Details and the full UI convention list: `apps/web/AGENTS.md` → "UI conventions".

**Why the rules are restated here instead of living only in the sub-file:**
context files are discovered by walking UP from the session cwd (omp
`context-file` capability, one file per ancestor depth). A session rooted at
the repo root therefore loads THIS file and never `apps/<app>/AGENTS.md` —
so every hard, cross-cutting rule an app-level file states must appear here
as an actionable line, with the sub-file kept as the detailed reference for
sessions actually running inside that app.



## Important Files

| File | Purpose |
|---|---|
| `apps/backend/src/main.ts` | Composition root — wires all services, adapters, routes |
| `apps/backend/src/app.ts` | Elysia app factory — mounts all feature routers |
| `apps/backend/src/features/agent-run/execution-dispatch.ts` | Run dispatch: preflight, workspace, projection, execute, settle, follow-up |
| `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` | Terminal commit, failed commit, next-run promotion |
| `apps/backend/src/features/agent-context/projection.ts` | Full branch projection (the only agent-context part with a production caller) |
| `apps/backend/src/infra/db/schema.ts` | Drizzle schema — 22 tables, single SQLite file |
| `apps/oh-my-agent/src/core/runtime/agent-loop.ts` | `createOmaSession()` — the agent loop |
| `apps/oh-my-agent/src/core/runtime/plugin.ts` | `Plugin`/`PluginHooks`, `validatePlugins()` |
| `packages/message/src/chat-model.ts` | `ChatModel` contract |
| `packages/agent-contract/src/backend.ts` | `AgentBackend` port + backend-kind registry |
| `apps/backend/src/features/coding/task-worktrees.ts` | Task-axis worktree listing + terminal path whitelist |
| `packages/ai/src/providers/anthropic-messages.ts` | Anthropic Messages API adapter |
| `apps/web/src/lib/api.ts` | Typed API client (Eden Treaty) |
| `apps/web/src/lib/client.ts` | BFF client + `unwrap()` helper |
| `biome.json` | Formatter (space/2/100) + linter config |
| `turbo.json` | Build pipeline (concurrency=1 for safety) |
| `tsconfig.base.json` | Shared strict TS config |
| `docs/architecture/design-philosophy.md` | 8 architectural principles |
| `docs/README.md` | Wiki front door: zones, task routing, writing rules |
| `docs/architecture/e2e-contract-rules.md` | Anti-fragmentation rules for cross-process types |
| `docs/architecture/db-typesafe-rules.md` | DB type chain rules (schema → service → http) |

## Runtime/Tooling Preferences

- **Runtime:** Bun only (do not suggest Node.js-specific APIs)
- **Next runtime:** `next`'s bin carries a `#!/usr/bin/env node` shebang, so `bun run <script>` executes Next under **Node**. To run it on Bun, invoke the file explicitly (`bun node_modules/next/dist/bin/next start`); verified working for SSR, middleware redirects, route handlers, and Server Components that read the backend with the privileged token.
- **Heavy builds:** `next build` (and `turbo run build`) still exceed this dev box (2 cores): it hangs for over an hour at "Creating an optimized production build" with near-zero CPU and drives RAM to 99%. Run it under `bash scripts/memguard.sh --limit <free>G -- <cmd>`, or in CI — which is where release artifacts get built anyway. The box has 8GB of RAM, but a running stack (backend + lark-bot + web dev) idles around 4–5GB, so SIZE THE CAP TO WHAT `free -m` REPORTS RIGHT NOW: memguard's OOM-kill is the intended failure mode (fast fail instead of swap thrash), while a cap above the free memory just lets the kernel pick its own victim — usually the backend.
- **Package manager:** `bun install` (bun.lock)
- **Formatting:** Biome (space/2/100, single quotes)
- **Linting:** Biome (recommended rules) + ESLint (TS-specific: `consistent-type-imports`, `no-unused-vars`)
- **TypeScript:** ESM with `NodeNext` resolution, target ES2023, strict mode, `noUncheckedIndexedAccess`
- **Git hooks:** Husky pre-commit (biome format + check) + commit-msg (commitlint conventional commits, no CJK)
- **CI:** `bun run typecheck && bun run lint && bun run test`
- **Package naming:** `@chengchenccc/<domain-name>` (domain-level, not engine/utility-level)

## Testing & QA

- **Framework:** `bun:test` (`describe`/`test`/`expect`)
- **Location:** `*.test.ts` files beside source
- **Model mocking:** Define scripted `ChatModel` implementations that yield predetermined turns. `echoModel()` from `@chengchenccc/test-helpers` provides a reusable factory.
- **Session store double:** `createInMemorySessionStore()` from `apps/oh-my-agent/src/core/store`
- **Integration tests:** Use `createOmaSession()` with real plugin hooks and scripted models
- **Workflow tests:** `packages/workflow` (engine/parse/schema) + `apps/backend/src/features/workflow/service.test.ts` / `trigger-scheduler.test.ts`
- **Coverage:** `bun run audit:coverage` enforces per-directory averages plus
  per-file floors for runtime-bearing files (agent loop, permissions, protocol,
  HTTP route surfaces, auth, SSE contract) in apps/oh-my-agent and
  apps/backend. Tests should cover behavior (branches, invariants, error
  handling), not plumbing
- **Test helpers:** `@chengchenccc/test-helpers` exports `echoModel()` with `EchoScript` type for deterministic model responses

## 编辑纪律（血泪教训）

本仓库的编辑工具（行区间 PUT/CUT）**多次吃掉相邻行**——一次编辑替换了一个区间，却在边界处吞掉了一行关键语句（如 `io.onLiveInput?.(steerHandler);`、`modelId = ...`、`cliSessionRef` 赋值），typecheck 依然通过但行为静默损坏，直到测试变红才暴露。

**每次编辑之后立刻回看 diff**，确认：
1. `git diff <file>` 中**没有任何非本意的 `-` 行**（删除的行必须是你打算删的）；
2. 该编辑的**上下文行完整**（函数头、闭合括号、赋值语句都在）；
3. 若编辑落在同一文件的连续区域，**一次改完**并整体重读该区域，不要连续小步微调。

批量小改时优先用整块重写（`write` 或大区间 PUT），而不是多次单行 PUT。
