# Architecture Constitution
## (Violation = CI Failure, Cannot Be Bypassed)

**This document contains mandatory, non-negotiable architectural constraints for all code in this repository. Every rule is enforced by `bun run check:all` — violations will block your PR.**

Version anchor: **Lobster v2.0** (post slash-promotion epic, M1 cut, branch `feature/lobster-m1-kernel`).
When this file and `DESIGN.md` disagree, **this file wins** — `DESIGN.md` is descriptive history, this file is prescriptive law.

---

## 0. Layering (the only allowed import direction)

```
domain/        ← pure types & invariants, no I/O
   ▲
application/   ← orchestration, ports, contracts, slash, hooks-as-types
   ▲
infrastructure/, extensions/, cli/, kernel/   ← adapters & wiring
```

- **GG-1 (Layer downwards)**: an inner layer MUST NOT import from an outer layer. `application/` may not import from `extensions/`, `infrastructure/`, `kernel/`, or `cli/`.
- **GG-2 (Ports own seams)**: every cross-layer dependency goes through a port declared in `application/ports/`. No extension reaches into another extension's internals.
- **GG-3 (One bus, contract-typed)**: all inter-extension messaging is `EventEnvelope<DataPlaneEventType, …>` over a single `EventBus`. There is no second bus, no shared mutable singleton.

---

## A. Entry Point and Assembly (Single Source of Truth)

- **Single assembly point**: `createKernel()` in `src/kernel/kernel.ts` + extension presets in `src/extensions/presets.ts`.
- `bin/*` may only: parse CLI parameters → assemble extensions via presets → call `createKernel()` → consume the event stream. They MUST NOT directly instantiate core objects, providers, or extension internals.
- Daemon entry: `bin/my-agent-daemon.ts`. CLI entry: `bin/my-agent-cli.ts`. There is no `src/interface/` directory — that path is from the v1 layout and has been removed.
- Configuration source priority: settings file < environment variables < CLI parameters. All three go through `src/infrastructure/config/`.

## B. Type Safety

- No new `as any`, `: any`, or `<any>` casts. Existing `any` usage is tracked via `.any-baseline.json` and must not increase.
- No "assertion-style interface patching" like `(x as SomeType & { ... })` — if a public API is missing, add it to the type definition.
- Discriminated unions must use `switch(event.type)` + exhaustive `never` check. No `(event as any).xxx`.

## C. Hook System

- The kernel hook system exposes **12 hooks**:
  `configureKernel`, `kernelReady`, `onTurnStart`, `transformPrompt`, `resolveTools`, `onToolCall`, `onLLMDelta`, `onTurnEnd`, `onTraceEmit`, `onIdentityChanged`, `onShutdown`, `serveControlMethod`.
  There is no `onSessionCreated` and no `onTaskCreated` hook — both were removed during the M1 trim.
- New hook points require justification in the PR description. Extensions must declare `enforce` ordering (`pre` / `normal` / `post`) for hook handlers.
- Hook dispatch modes: **3 modes**, set per-hook in `HOOK_MODES`:
  - `sequential` — order matters, errors propagate. Used by: `configureKernel`, `onTurnStart`, `transformPrompt`, `resolveTools`, `onToolCall`, `onShutdown`.
  - `parallel` — fire-and-forget, errors logged. Used by: `kernelReady`, `onLLMDelta`, `onTurnEnd`, `onTraceEmit`, `onIdentityChanged`.
  - `first-match` — first non-null handler wins. Used by: `serveControlMethod`.
  There is no `pre-intercept` / `post-intercept` mode.

## D. Extension System

- Extensions register via `defineExtension({ name, enforce?, dependsOn?, apply })`.
- The `apply(ctx)` function returns a partial of:
  ```ts
  {
    provide?:   Record<string, unknown>
    hooks?:     Partial<HookMap>
    subscribe?: Record<DataPlaneEventType, Handler>
    rpc?:       Record<string, RpcHandler>
    slash?:     SlashCommand[]      // promoted to first-class in commit 42c725a
    dispose?:   () => Promise<void> | void
  }
  ```
  No other top-level keys are permitted.
- `KernelContext` (passed to `apply`) is frozen to:
  `{ agentId, paths, extensions, bus, hooks, rpc, clock, logger, config }`.
  `agentDir` is `@deprecated` — read `paths.agentDir`. There is no `profileId` / `profileDir`.
- Extensions communicate through three channels only: `ctx.bus` (events), `ctx.extensions.get()` (capabilities via ports), and `ctx.hooks.dispatch()` (hooks). Direct cross-extension imports are blocked by ESLint.
- Extension ordering: topo-sorted by `dependsOn`, then by `enforce` phase (`pre` → `normal` → `post`). Within same phase, insertion order. Cycles are a fatal kernel error.
- Current extension count: **18**, in `src/extensions/`:
  `controlplane, dataplane, evolution, frontend.lark, frontend.tui, identity, infra-services, mcp, memory, permission, provider, session, skills, tool-catalog, tools, trace, transport.inmem, transport.unix`.

## E. Contract Sovereignty (INV-Data-1 through INV-Data-7)

- **INV-Data-1**: All cross-boundary data contracts (events, transport messages, persistent records) must be defined in `src/application/contracts/**`.
- **INV-Data-2**: `src/application/ports/**` must not import `src/extensions/**`, `src/infrastructure/**`, or `src/kernel/**`. (Note: there is no `src/core/` directory — references to `src/core/frontend/**` in older drafts are stale.)
- **INV-Data-3**: `DataPlaneEventType` sovereignty belongs to `application/contracts/dataplane-event.ts`, not `extensions/dataplane/`. Adding a type requires updating the union AND its enumerator comment.
- **INV-Data-4**: All persistent records must carry `version`. Readers must fail-soft on unknown versions.
- **INV-Data-5**: New contracted events must provide type + `createEvent` factory + parse/decode if they cross a transport boundary.
- **INV-Data-6**: No public contract types may be added to a catch-all `src/types.ts` — that file does not exist in the current layout; use `application/contracts/**`.
- **INV-Data-7**: Transport adapters may only depend on `ports/` and `contracts/`, not `extensions/`.

## F. Ports / Adapters

- `application/ports/` defines abstract interfaces (anti-corruption layer). `infrastructure/` implements them. Extensions consume ports, infrastructure provides adapters.
- Ports must not import from `extensions/` or `infrastructure/`. Adapters must not import from `extensions/`.
- New external integrations: define the port in `ports/`, implement the adapter in `infrastructure/`, wire in an extension.

## G. Zod Boundary

- Zod is restricted to `src/application/contracts/**` for runtime schema validation at data boundaries.
- Other layers use the codecs exported by contracts (`createCodec().encode/decode/safeDecode`), not raw zod.
- Configuration validation in `src/infrastructure/config/schema.ts` is exempt.

## H. Slash Command Sovereignty (A18.5 / A19.2 / A19.3 / A20)

- **A18.5**: Slash is an `application/` first-class citizen. Registry, types, and built-ins live in `src/application/slash/**`. Frontends consume; extensions contribute.
- **A19.2**: Built-in slash commands are registered via `registerBuiltinSlashCommands(registry, opts?)`. The set is fixed: `clear, compact, cost, tools, exit, daemon, cancel, help`. Adding a built-in requires a constitution amendment.
- **A19.3**: An extension contributes commands via `defineExtension({ slash: [...] })`. The kernel surfaces them via `ExtensionRegistry.collectSlashCommands()`. Frontends MUST call this and merge with `registerBuiltinSlashCommands`.
- **A20**: ESLint guards `src/application/slash/**` against importing from `extensions/`, `infrastructure/`, or `kernel/`. Slash implementations that need infra go through `SlashContext.kernel.rpc`.

> **Known regression (M1)**: `frontend.tui` and `frontend.lark` do not currently call `collectSlashCommands()`. Extension-contributed slashes (`/trace`, `/memory`, `/evolve`) are silently absent. Tracked as P0 in the pre-merge fix spec.

## I. DRY / Dead Code

- When fixing bugs, if you find duplicate code, consolidate it. Do not "just copy one more time."
- `tsc --noUnusedLocals` is a hard threshold — unused imports/variables cannot be merged.
- Unused exports reported by `knip` must be cleaned or annotated. Acceptable JSDoc tags: `@public`, `@internal`, `@knipignore`. Annotation is registered via `knip.json` `"tags": ["-public", "-internal"]`. (Note: knip v5 silently ignores invalid schema keys with exit 0 — verify by running `bun run knip` and checking the issue table, not just the exit code.)

## J. Size Control

- Single file > 400 lines: PR must justify or split.
- Single function > 80 lines: must be split.

## K. Testing Threshold

- New public APIs (exported classes/functions) must include unit tests under `tests/`.
- Bug fixes must first write a reproduction case, and include the original failure output in the PR.
- Extension tests use `createTestKernel()` from `tests/helpers/kernel-helper.ts` for isolated kernel boot.

## L. CLI Manifest Sovereignty

- Every CLI subcommand-bearing extension exports a `cliManifest: CliManifest` and a `_CheckCliManifest` compile-time assertion.
- `_CheckCliManifest` exports may be marked `@internal` for knip, but their presence is enforced by `assert-cli-bearing.ts` — absence is a CI failure.

## M. Forbidden Patterns

The following code patterns appearing in diffs will be directly blocked by `check:arch`:

- `new Agent(`, `new ToolRegistry(`, `new ContextManager(` — these classes no longer exist; use `createKernel()` + extensions.
- `as any` or `: any` (new occurrences; baseline tracked in `.any-baseline.json`).
- `console.log` (use `ctx.logger` or `debugLog`).
- `// @ts-ignore` / `// @ts-expect-error` without justification comment.
- Numeric literals beyond `-1 / 0 / 1 / 2` must be named constants.
- Importing `extensions/**` from `ports/**`, `application/slash/**`, or `infrastructure/transport/**`.
- Importing `zod` outside `src/application/contracts/**` (config schema exempt).

## N. Requirements for AI Coding Assistants

- Before any refactoring, run `git grep` to find similar implementations; prioritize reuse.
- Before modifying core kernel files (`kernel.ts`, `define-extension.ts`, `hook-container.ts`, `event-bus.ts`), **read the entire file first**.
- Before completing a task, self-check against §A–M and list violations in the final response.
- If you need to bypass a constraint, write `RFC: <reason>` in the PR description for human approval.
