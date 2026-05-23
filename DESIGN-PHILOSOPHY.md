# Design Philosophy

This document captures the design taste, recurring patterns, and architectural principles that make this codebase coherent. It exists to guide future design decisions — when adding a new feature, these patterns are your first draft, not an afterthought.

Anchored to: **Lobster v2.0**, branch `feature/lobster-m1-kernel`. Where this file gives a count or names a hook, the canonical source is `ARCHITECTURE-CONSTITUTION.md` plus the code; if they ever drift, **the constitution and the code win**.

---

## 1. Kernel + Extensions Assembly (DI Without a Framework)

Every subsystem is wired as a `defineExtension()` call. Entry points in `bin/` are thin wrappers that parse CLI args, select an extension preset, and call `createKernel()`. They never construct core objects directly.

The assembly order is declarative: each extension declares `dependsOn` (topo-sorted) and `enforce` phase (`pre` → `normal` → `post`). The kernel resolves the dependency graph and boots extensions in correct order. Cycles are a fatal error, not a warning.

**Why**: Extensions are self-contained, independently testable, and composable. New contributors read one extension to understand one subsystem. Extension presets in `src/extensions/presets.ts` bundle extensions for different scenarios (TUI, headless, daemon). There is no magic DI container — just dependency ordering.

**How to apply**: New subsystems are extensions (`defineExtension()`). They declare what they depend on and what phase they run in. They communicate via bus events, capability lookup, and hooks — never direct imports. The assembly presets in `presets.ts` are the single place where extension sets are chosen.

---

## 2. Hook-Based Extensibility Everywhere

Both the kernel lifecycle and tool execution use the same hook dispatch pattern. The kernel exposes **12 hooks** with **3 dispatch modes** (set per-hook in `HOOK_MODES`):

- `sequential` — ordered, errors propagate. Used by: `configureKernel`, `onTurnStart`, `transformPrompt`, `resolveTools`, `onToolCall`, `onShutdown`.
- `parallel` — fire-and-forget, errors logged. Used by: `kernelReady`, `onLLMDelta`, `onTurnEnd`, `onTraceEmit`, `onIdentityChanged`.
- `first-match` — first non-null wins. Used by: `serveControlMethod`.

Key hook chain during a turn: `transformPrompt → resolveTools → onTurnStart → onToolCall → onLLMDelta → onTurnEnd → onTraceEmit`. Extensions register handlers with `enforce` ordering (`pre` / `normal` / `post`). There is no `pre-intercept` / `post-intercept` mode and no `onSessionCreated` / `onTaskCreated` hook — both were removed in M1.

**Why**: The hook system is the simplest composable extension mechanism. It doesn't require inheritance or class hierarchies. Each hook handler is a function of `(...args) => result`. New behaviors slot in by registering on existing hooks without modifying dispatch logic.

**How to apply**: When adding a cross-cutting concern (logging, validation, caching, telemetry), ask "is this a hook handler?" before "is this a new class?". Register on existing hooks — don't add new hook points without justification.

---

## 3. Discriminated Union Events, Never Type-Casting

The domain layer yields `TurnEvent` — a discriminated union. The dataplane bridges bus events to `DataPlaneEvent` (closed union of types defined in `application/contracts/dataplane-event.ts`). The TUI converts to its own view-model for rendering. At every level, consumers use `switch(event.type)` with exhaustive `never` checks. No `(event as any).xxx` anywhere.

**Why**: TypeScript's control flow narrowing on discriminated unions gives you compile-time guarantees that every event variant is handled. When a new event type is added, the compiler flags every consumer that needs updating. This is the single best TypeScript pattern for correctness under change.

**How to apply**: New features that add information to the event stream add a new variant to `TurnEvent` and/or `DataPlaneEventType`, then fix every `switch` that breaks. Events crossing boundaries are wrapped in `EventEnvelope` via `createEvent()`. Never smuggle data through optional fields on existing events.

---

## 4. Everything Is a Tool

The LLM only knows `function_call`. Every capability — file operations, MCP servers, memory search, skill creation, MCP prompts, MCP resources — is presented to the model as a tool. There is no separate abstraction for "things the model can do."

MCP prompts become tools. MCP resources get a `mcp_read_resource` tool + an injected catalog. Server management has `mcp_list/add/remove_server` tools.

**Why**: The LLM has one interaction primitive. Building parallel abstractions means the model can't discover or use them. Uniformity means the model learns one pattern and applies it everywhere.

**How to apply**: When integrating a new external capability, the first question is "what tool(s) does the model call?". Not "what API do we expose to the code?".

---

## 5. Slash Commands Are an `application/` First-Class Citizen

Slash commands used to be owned by `frontend.tui`. As of commit `42c725a` (slash-promotion epic) they are owned by `application/slash/**`. Extensions contribute via `defineExtension({ slash: [...] })`. Frontends consume via `registerBuiltinSlashCommands(registry)` plus `ExtensionRegistry.collectSlashCommands()`.

ESLint rule **A20** prevents `application/slash/**` from importing `extensions/**`, `infrastructure/**`, or `kernel/**`. Slash command implementations that need infrastructure go through `SlashContext.kernel.rpc(...)`.

**Why**: Slash is a UI primitive that crosses every frontend (TUI, Lark). Pinning it to one frontend forced duplication; pinning it to a kernel surface tied UX to a wiring layer. `application/` is the right home — it owns the contract, the registry, and the built-in set, while remaining frontend-agnostic.

**How to apply**: New built-ins go to `src/application/slash/builtin/`. New extension-contributed commands go on the extension's `slash` channel. If a slash needs infra, expose an RPC method on the owning extension and call it from the slash via `ctx.kernel.rpc`.

> **Live caveat**: At M1 cut, frontends do not yet call `collectSlashCommands()`. The wiring is the P0 fix in the pre-merge spec.

---

## 6. Progressive Disclosure (Pay for What You Use)

Load metadata eagerly, load full content on demand:

- Skills inject their name + description into the system prompt always, but only inject full `SKILL.md` content when the model mentions the skill by name.
- MCP resources are listed in `ephemeralReminders` as a catalog, fetched individually via `mcp_read_resource`.
- Memory retrieves only top-N relevant entries, not the full store.

**Why**: Context window is the scarcest resource. Every token spent on something the model *might* need is a token stolen from something it *does* need.

**How to apply**: New information sources (docs, APIs, configurations) should inject a summary/catalog first, with a tool to fetch details. Never dump everything into the system prompt "just in case."

---

## 7. Least-Destructive-First (Graduated Response)

Context compaction uses 5 tiers, escalating only when the gentler tier is insufficient:

| Tier | Usage | Strategy |
|------|-------|----------|
| 0 | < 60% | Do nothing |
| 1 | 60–75% | Snip large tool outputs |
| 2 | 75–95% | LLM-summarize old messages |
| 3 | API error | Emergency truncation |
| 4 | > 95% | Nuclear: system + summary + last 2 |

**Why**: Aggressive action destroys information. If a gentler approach works, you've preserved more context. The same principle applies beyond compaction: circuit breakers escalate per-tier → global only after repeated failures. Rate limiters use token buckets, not hard caps. Backoff uses exponential + jitter, not fixed delays.

**How to apply**: Any resource management system should have at least 3 tiers: do-nothing, gentle, aggressive. The jump from "fine" to "nuclear" is never acceptable.

---

## 8. Side Effects Are Declared, Not Hidden

Every tool declares its side-effect profile: `readonly?: boolean` (can it run in parallel?) and `conflictKey?(args): string | null` (which resources does it touch?).

The dispatcher uses these declarations to build execution waves. Read-only tools run in parallel. Write tools that touch different resources run in parallel. Write tools that touch the same resource are serialized.

**Why**: The dispatcher can't reason about tool safety without explicit declarations. Implicit parallelism leads to race conditions. Explicit side-effect modeling means the system optimizes concurrency automatically and safely.

**How to apply**: Every new tool must declare `readonly` and `conflictKey`. If a tool's side effects change based on arguments, `conflictKey` is a function, not a boolean.

---

## 9. Atomic Claims, Not Locks

The evolution queue uses `O_EXCL` file creation for atomic task claiming. No mutexes, no distributed locks, no leader election. A task is claimed when a file is created — the filesystem is the arbiter.

**Why**: File-system atomicity is the simplest concurrency primitive that works across processes, survives crashes, and leaves no orphaned locks. A claimed task with a stale mtime heartbeat is a zombie and gets reaped by the next drainer — no deadlock possible.

**How to apply**: When building persistent queues, work pools, or claim-based systems, use `O_EXCL` (or its equivalent) before reaching for a lock. The filesystem is your database.

---

## 10. Timeout + Abort Signal on Every Boundary

Every external call has a timeout. Every tool execution gets an `AbortSignal`. The agent loop has a global timeout. MCP connections have timeouts. Tool dispatch has per-tool timeouts. The abort signal propagates through MCP tool adapters to the underlying SDK.

**Why**: The worst failure mode is not "it crashed" — it's "it hung forever." Timeouts convert hangs into errors. Abort signals let the system clean up cleanly.

**How to apply**: Every new async operation that crosses a boundary (network, subprocess, filesystem) must accept an `AbortSignal` or have a timeout. No exceptions. When composing, forward the parent signal.

---

## 11. Incremental Computation Over Periodic Recalculation

The token counter updates incrementally — each added message increments the total by that message's token count. The full recount only runs on infrequent operations (compaction, clear).

**Why**: Recalculating all message tokens on every budget check was O(N) and blocked the event loop for seconds on large conversations. Incremental updates make it O(1) with bounded error. The tradeoff (potential drift) is corrected at known safe points.

**How to apply**: When adding a metric that could be computed on-demand vs. maintained incrementally, prefer incremental. If you need the exact value for correctness, recalculate at known safe points (not every access).

---

## 12. Factory Functions + Extensions Over Class Hierarchies

Most subsystems are created by factory functions:

- `defineExtension({ name, apply(ctx) })` returns `{ provide, hooks, subscribe, rpc, slash, dispose }`
- `createKernel(opts)` returns the kernel handle
- `createCodec(schema)` returns `{ encode, decode, safeDecode }` — symmetric codec factory
- `createEvent(type, payload, opts?)` returns `EventEnvelope` — versioned event factory

**Why**: Factory functions make dependency injection explicit. Extensions declare dependencies declaratively (`dependsOn`). The kernel resolves the graph. Class hierarchies hide dependencies in constructors and encourage inheritance for code reuse (which couples unrelated things). Extensions compose; classes inherit.

**How to apply**: New subsystems should be extensions. If you find yourself writing `class A extends B`, stop — use composition through an extension factory instead.

---

## 13. Zod at Every Boundary

Every external input is validated with Zod, but **only inside `application/contracts/**`**:

- Configuration files (`src/infrastructure/config/schema.ts` is the single exemption).
- Tool argument schemas, declared via the tool's contract.
- MCP server configs.

Other layers consume the codecs exported by contracts (`createCodec().encode/decode/safeDecode`), not raw zod.

**Why**: Parse, don't validate. A Zod schema is both the validation and the TypeScript type — no duplication, no drift. Invalid data is rejected at the boundary with a clear error, never silently propagated. Restricting zod to contracts means the boundary is the only place that knows the schema language.

**How to apply**: Any new tool, config section, or external data source gets a Zod schema in `contracts/`. Derive TypeScript types with `z.infer<>`. Never write a manual type and a separate validation function. Never `import { z } from 'zod'` outside contracts/config-schema.

---

## 14. No Magic Strings, No Magic Numbers

Named constants for everything. String literals that form a closed set use `as const` arrays with derived types. Duplicate literal occurrences across files are consolidated into a constants module.

**Why**: Magic values rot silently — "what does 120000 mean?" vs. `DEFAULT_TOOL_TIMEOUT_MS`. Named constants document intent. Consolidated constants prevent drift where two files use different values for the same concept.

**How to apply**: Before adding any numeric literal or string literal, check the existing constants module. If the value forms a set (statuses, modes, levels), use `as const` tuple + derived type.

---

## 15. Views Organized by Purpose, Not Type

The TUI components are organized by their role in the rendering lifecycle:

- `views/chrome/` — persistent UI frame (header, footer, input)
- `views/active/` — live streaming content
- `views/final/` — committed, scrollable history
- `overlays/` — modal interactions
- `panels/` — embedded widgets

Not by technical category (not "containers/", "presentational/", "atoms/", "molecules/").

**Why**: When debugging a streaming bug, you only look in `views/active/`. When fixing a history rendering issue, you only look in `views/final/`. The directory structure mirrors the rendering lifecycle, which is what developers actually think about.

**How to apply**: Organize by what the code does in the user-visible lifecycle, not by what it is in a design-system taxonomy. The split should make the first directory you look in obvious from the bug report.

---

## 16. Trade-Offs Are Documented, Not Hidden

`DESIGN.md` (long-form, descriptive) explicitly calls out trade-offs for every subsystem. This file (prescriptive) tells you to do the same when you add one.

**Why**: Every design decision is a trade-off. Hiding the downsides means future maintainers rediscover them painfully. Explicit documentation means they know what to watch for and when to revisit the decision.

**How to apply**: When adding a subsystem, include a "Trade-offs" section in the relevant doc. What's the worst case? What did you optimize for? What would you do differently if requirements changed?

---

## Quick Reference: When Adding a Feature

1. New subsystem? Make it an extension (`defineExtension()`), wire it in `presets.ts`.
2. Cross-cuts existing flows? Register on an existing hook — don't add new hook points.
3. Model-facing? Make it a tool — not a separate abstraction.
4. Cross-boundary data? Define in `application/contracts/` with Zod codec.
5. New abstraction? Define the port in `application/ports/`, implement in `infrastructure/`.
6. New event type? Add to `DataPlaneEventType` and/or `TurnEvent`, fix every switch the compiler flags.
7. External input? Zod schema first, in `contracts/` (config schema is the only exemption).
8. New slash command? Built-in goes in `application/slash/builtin/`; extension-owned goes on the extension's `slash` channel.
9. Can it hang? Add a timeout and accept an `AbortSignal`.
10. Side effects? Declare `readonly` / `conflictKey`; communicate via bus events.
11. New TUI component? Pick the right `views/` directory by lifecycle role.
12. Design trade-off? Document it in `DESIGN.md`.
