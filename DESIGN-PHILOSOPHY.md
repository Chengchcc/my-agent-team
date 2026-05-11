# Design Philosophy

This document captures the design taste, recurring patterns, and architectural principles that make this codebase coherent. It exists to guide future design decisions — when adding a new feature, these patterns are your first draft, not an afterthought.

---

## 1. Single Assembly Point (DI Without a Framework)

Every subsystem is wired in exactly one place: `createAgentRuntime()` in `src/runtime.ts`. Entry points in `bin/` are thin wrappers that parse CLI args and call this function. They never construct core objects directly.

**Why**: When all wiring is visible in one file, you can trace any dependency without grep. New contributors read one function to understand how the system fits together. There is no magic DI container or auto-wiring — it's just a long, linear, readable function.

**How to apply**: New subsystems get a `setupXxx()` internal function in `runtime.ts`. They don't get their own initialization exported to `bin/`. The assembly order matters and is documented — step 1 through 14 in DESIGN.md.

---

## 2. Onion Middleware Everywhere

Both agent hooks and tool middleware use the same compose pattern: each layer wraps the next, outer runs first, inner runs last, result flows back through all layers.

```
Agent:  beforeAgentRun → beforeModel → [LLM] → afterModel → beforeAddResponse → afterAgentRun
Tool:   Permission → ReadCache → Trace → tool.execute()
```

**Why**: The onion is the simplest composable extension mechanism. It doesn't require inheritance, registration, or lifecycle management. Each middleware is a pure function of `(ctx, next) => ctx`. New behaviors slot in without modifying existing code.

**How to apply**: When adding a cross-cutting concern (logging, validation, caching, telemetry), ask "is this a middleware?" before "is this a new class?". The answer is usually yes. Don't add new hook points without an RFC — the existing 6 are frozen by the Architecture Constitution.

---

## 3. Discriminated Union Events, Never Type-Casting

The agent loop yields `AgentEvent` — a discriminated union of ~16 event types. Consumers use `switch(event.type)` with exhaustive `never` checks. No `(event as any).xxx` anywhere.

**Why**: TypeScript's control flow narrowing on discriminated unions gives you compile-time guarantees that every event variant is handled. When a new event type is added, the compiler flags every consumer that needs updating. This is the single best TypeScript pattern for correctness under change.

**How to apply**: New features that add information to the event stream add a new variant to the union, then fix every `switch` that breaks. Never smuggle data through optional fields on existing events.

---

## 4. Everything Is a Tool

The LLM only knows `function_call`. Every capability — file operations, MCP servers, memory search, skill creation, MCP prompts, MCP resources — is presented to the model as a tool. There is no separate abstraction for "things the model can do."

MCP prompts become tools. MCP resources get a `mcp_read_resource` tool + an injected catalog. Server management has `mcp_list/add/remove_server` tools.

**Why**: The LLM has one interaction primitive. Building parallel abstractions means the model can't discover or use them. Uniformity means the model learns one pattern and applies it everywhere.

**How to apply**: When integrating a new external capability, the first question is "what tool(s) does the model call?". Not "what API do we expose to the code?".

---

## 5. Progressive Disclosure (Pay for What You Use)

Load metadata eagerly, load full content on demand:
- Skills inject their name + description into the system prompt always, but only inject full `SKILL.md` content when the model mentions the skill by name
- MCP resources are listed in `ephemeralReminders` as a catalog, fetched individually via `mcp_read_resource`
- Memory retrieves only top-N relevant entries, not the full store

**Why**: Context window is the scarcest resource. Every token spent on something the model *might* need is a token stolen from something it *does* need. Progressive disclosure keeps the context lean.

**How to apply**: New information sources (docs, APIs, configurations) should inject a summary/catalog first, with a tool to fetch details. Never dump everything into the system prompt "just in case."

---

## 6. Least-Destructive-First (Graduated Response)

Context compaction uses 5 tiers, escalating only when the gentler tier is insufficient:

| Tier | Usage | Strategy |
|------|-------|----------|
| 0 | < 60% | Do nothing |
| 1 | 60-75% | Snip large tool outputs |
| 2 | 75-95% | LLM-summarize old messages |
| 3 | API error | Emergency truncation |
| 4 | > 95% | Nuclear: system + summary + last 2 |

**Why**: Aggressive action destroys information. If a gentler approach works, you've preserved more context. This applies beyond compaction: circuit breakers escalate from per-tier → global only after repeated failures. Rate limiters use token buckets, not hard caps. Backoff uses exponential + jitter, not fixed delays.

**How to apply**: Any resource management system should have at least 3 tiers: do-nothing, gentle, aggressive. The jump from "fine" to "nuclear" is never acceptable.

---

## 7. Side Effects Are Declared, Not Hidden

Every tool declares its side-effect profile: `readonly?: boolean` (can it run in parallel?) and `conflictKey?(args): string | null` (which resources does it touch?).

The `planExecution` function in `dispatch.ts` uses these declarations to build execution waves. Read-only tools run in parallel. Write tools that touch different resources run in parallel. Write tools that touch the same resource are serialized.

**Why**: The dispatcher can't reason about tool safety without explicit declarations. Implicit parallelism leads to race conditions. Explicit side-effect modeling means the system optimizes concurrency automatically and safely.

**How to apply**: Every new tool must declare `readonly` and `conflictKey`. If a tool's side effects change based on arguments, `conflictKey` is a function, not a boolean.

---

## 8. Atomic Claims, Not Locks

The evolution queue (`persistent-queue.ts`) uses `O_EXCL` file creation for atomic task claiming. No mutexes, no distributed locks, no leader election. A task is claimed when a file is created — the filesystem is the arbiter.

**Why**: File-system atomicity is the simplest concurrency primitive that works across processes, survives crashes, and leaves no orphaned locks. A claimed task with a stale mtime heartbeat is a zombie and gets reaped by the next drainer — no deadlock possible.

**How to apply**: When building persistent queues, work pools, or claim-based systems, use `O_EXCL` (or its equivalent) before reaching for a lock. The filesystem is your database.

---

## 9. Timeout + Abort Signal on Every Boundary

Every external call has a timeout. Every tool execution gets an `AbortSignal`. The agent loop has a global timeout. MCP connections have timeouts. Tool dispatch has per-tool timeouts. The abort signal propagates through MCP tool adapters to the underlying SDK.

**Why**: The worst failure mode is not "it crashed" — it's "it hung forever." Timeouts convert hangs into errors. Abort signals let the system clean up cleanly. Without them, any external dependency can freeze the entire agent.

**How to apply**: Every new async operation that crosses a boundary (network, subprocess, filesystem) must accept an `AbortSignal` or have a timeout. No exceptions. When composing, forward the parent signal.

---

## 10. Incremental Computation Over Periodic Recalculation

The token counter in `ContextManager` updates incrementally — each added message increments the total by that message's token count. The full recount only runs on infrequent operations (compaction, clear).

**Why**: Recalculating all message tokens on every budget check was O(N) and blocked the event loop for seconds on large conversations. Incremental updates make it O(1) with bounded error. The tradeoff (potential drift) is corrected at known safe points.

**How to apply**: When adding a metric that could be computed on-demand vs. maintained incrementally, prefer incremental. If you need the exact value for correctness, recalculate at known safe points (not every access).

---

## 11. Factory Functions Over Class Hierarchies

Most subsystems are created by factory functions that return plain objects or classes with hooks:

- `createSkillMiddleware()` returns `{ beforeAgentRun, beforeModel }`
- `createTodoMiddleware()` returns `{ tool, hooks }`
- `createTraceMiddleware()` returns `{ agentMiddleware, toolMiddleware }`
- `createAgentRuntime()` returns `AgentRuntime` with all wired components

**Why**: Factory functions make dependency injection explicit. You can see every dependency in the function signature. Class hierarchies hide dependencies in constructors and encourage inheritance for code reuse (which couples unrelated things). Factories compose; classes inherit.

**How to apply**: New subsystems should expose a `createXxx(deps)` function. If you find yourself writing `class A extends B`, stop — use composition through a factory instead.

---

## 12. Zod at Every Boundary

Every external input is validated with Zod:
- Configuration files (`src/config/schema.ts`)
- Tool arguments (`ZodTool` base class in `src/tools/zod-tool.ts`)
- MCP server configs (Zod in `server-persistence.ts`)

**Why**: Parse, don't validate. A Zod schema is both the validation and the TypeScript type — no duplication, no drift. Invalid data is rejected at the boundary with a clear error, never silently propagated.

**How to apply**: Any new tool, config section, or external data source gets a Zod schema. The schema defines the type; derive TypeScript types from it with `z.infer<>`. Never write a manual type and a separate validation function.

---

## 13. No Magic Strings, No Magic Numbers

Named constants for everything. String literals that form a closed set use `as const` arrays with derived types. Duplicate literal occurrences across files are consolidated into `src/config/constants.ts`.

**Why**: Magic values rot silently — "what does 120000 mean?" vs. `DEFAULT_TOOL_TIMEOUT_MS`. Named constants document intent. Consolidated constants prevent drift where two files use different values for the same concept.

**How to apply**: Before adding any numeric literal or string literal, check `src/config/constants.ts` for an existing constant. If the value forms a set (statuses, modes, levels), use `as const` tuple + derived type.

---

## 14. Views Organized by Purpose, Not Type

The TUI components are organized by their role in the rendering lifecycle:
- `views/chrome/` — persistent UI frame (header, footer, input)
- `views/active/` — live streaming content
- `views/final/` — committed, scrollable history
- `views/overlay/` — modal interactions
- `components/` — shared primitives

Not by technical category (not "containers/", "presentational/", "atoms/", "molecules/").

**Why**: When debugging a streaming bug, you only look in `views/active/`. When fixing a history rendering issue, you only look in `views/final/`. The directory structure mirrors the rendering lifecycle, which is what developers actually think about.

**How to apply**: Organize by what the code does in the user-visible lifecycle, not by what it is in a design-system taxonomy. The split should make the first directory you look in obvious from the bug report.

---

## 15. Trade-Offs Are Documented, Not Hidden

The DESIGN.md explicitly calls out trade-offs for every subsystem:
- Budget-guard estimates tool output sizes (may overflow for large files)
- planExecution's side-effect classification is a hardcoded switch (custom tools default to serial)
- serializeAndTruncate silently drops fields from large objects
- AgentLoop singleton prevents concurrent processing of the same instance

**Why**: Every design decision is a trade-off. Hiding the downsides means future maintainers rediscover them painfully. Explicit documentation means they know what to watch for and when to revisit the decision.

**How to apply**: When adding a subsystem, include a "Trade-offs" section. What's the worst case? What did you optimize for? What would you do differently if requirements changed?

---

## Quick Reference: When Adding a Feature

1. Wire it in `createAgentRuntime()` — not in `bin/*`
2. Does it cross-cut? Make it a middleware — don't add hook points
3. Does the model need it? Make it a tool — not a separate abstraction
4. New event type? Add to the union, fix all switches
5. External input? Zod schema first
6. New constants? Check `src/config/constants.ts` first
7. Can it hang? Add a timeout and accept an AbortSignal
8. Side effects? Declare `readonly` and `conflictKey`
9. New TUI component? Pick the right `views/` directory by lifecycle role
10. Design trade-off? Document it in DESIGN.md
