# AGENTS.md — apps/oh-my-agent

Working contract for the **Oma CLI** (`oma`). This is the runtime agent
core that the Product Backend spawns for each Run.

## What this app is

- A run-centric CLI agent in four modes: `print`, `json`, `rpc`, and
  interactive `tui`.
- `rpc` mode is the product integration surface: the backend adapter spawns
  `oma --mode rpc` and speaks JSONL over stdin/stdout.
- `print`/`json` are one-shot CLI modes; `tui` is a full interactive
  terminal with streaming render, branch tree, tools, and slash commands.

## Commands

Run from `apps/oh-my-agent`:

```bash
bun run dev          # bun src/cli.ts
bun run build        # tsc -p tsconfig.json + copy prompts + chmod dist/cli.js
bun run typecheck    # tsc -p tsconfig.test.json --noEmit
bun run lint         # biome check . && eslint .
bun run test         # bun test
```

## Architecture

```
src/
  cli.ts               # entrypoint
  main.ts              # mode dispatch + argument parsing
  core/
    runtime/README.md  # reading order + file map (start here)
    runtime/create-runtime.ts  # createOmaRuntime: the per-Run facade
    runtime/run-runtime.ts     # assembleRunRuntime: tools, gates, plugins
    runtime/agent-loop.ts      # createOmaSession (the loop factory)
    runtime/plugin.ts          # Plugin + hooks + validatePlugins
    runtime/plugin-runtime.ts  # runtime capabilities injected into hooks
    runtime/tool-filter.ts     # --tools whitelist/blacklist
  modes/
    print-mode.ts
    json-mode.ts
    rpc/rpc-mode.ts    # JSONL protocol (stdout is protocol-only)
    tui/
  core/tools/          # native tools (bash, grep, todo, eval, ...)
  core/session/        # CLI-owned session files (JSONL): resume/fork
  core/loops/          # loop mode: limits, condition, ralph
  core/goals/          # goal mode state machine + tool
  core/plans/          # plan mode state machine + prompts
  core/gateway/        # `oma gateway` daemon, supervisor, doctor
  core/settings/       # .oma/settings.json + workspace context
  core/plugins/        # plugin loading/trust
  core/memory/         # autonomous memory
```

## Cross-file imports

- **Internal cross-file imports are relative with `.js` extension**
  because the package compiles to ESM under `NodeNext`
  (`import { runCli } from "./main.js"`). Do not use extensionless
  relative imports.
- **Workspace packages are imported by package name**
  (`@chengchenccc/message`, `@chengchenccc/ai`, `@chengchenccc/sandbox`, ...).
  Never use monorepo paths like `../../packages/...`.
- Example cross-file doc entry point to read first:
  [docs/README.md](../../docs/README.md).

## Rules and invariants

- `backend` is the source of truth for product state; `oma` is the runtime
  only. RPC mode must never write product DB.
- In `rpc` mode, **stdout is protocol-only** JSONL. No logs or debug text on
  stdout; logs go to stderr.
- Tool filtering happens at the final tool table (native + MCP + plugins)
  in run-runtime. The model never sees a filtered tool.
- Product-injected tools mount via MCP and take priority over native tools
  (e.g. MCP `todo_write` suppresses native todo).
- Plugin hooks receive a `runtime` (rt) parameter with stream/model/store
  abilities — no `pi`/jiti dynamic loading.
- `RunRuntimeDeps` carries env/test knobs; backend forwards
  `OMA_FAKE_*` through the adapter for in-process smoke tests.

## Known pitfalls

- **Bun timers in `Promise.race` must be cleared** or the process lingers
  after the race settles (15s hang).
- **Bun.spawn throws ENOENT on a missing cwd.**
- **RPC acceptance ordering:** record `execute` finished BEFORE responding
  success; the reader must not await the full run outcome or steer/abort
  never arrive.
- **`StdioClientTransport` does not inherit process env.** Custom test knobs
  (`MCP_ECHO_*`) must travel via `.mcp.json` `env`, not via the parent
  process environment.
- **Default model must come from the run's model binding** (`run model`),
  not `catalog[0]`. Budget + summarizer bind to the run model.

## Related docs

- [docs/README.md](../../docs/README.md) — repo wiki front door
- [docs/architecture/runtime/oma.md](../../docs/architecture/runtime/oma.md) — the oma runtime wiki
- [docs/architecture/runtime/compaction.md](../../docs/architecture/runtime/compaction.md)
- [docs/architecture/plugins/oma-plugins.md](../../docs/architecture/plugins/oma-plugins.md)
- [docs/architecture/backend/overview.md](../../docs/architecture/backend/overview.md)

## Review checklist

1. `bun run typecheck` passes.
2. `bun run lint` passes.
3. `bun run test` passes.
4. RPC stdout remains protocol-only; no stray `console.log`.
5. Changes don't touch the backend DB or product truth.

## Directory naming (core/)

Feature directories under `src/core/` are named after the DOMAIN, plural where the
directory holds a family of things — `coordination/`, `delegation/`, `plugins/`,
`tools/`, `goals/`, `loops/`, `plans/`. No `-mode`/`-manager`/`-helper` suffixes:
the suffix encodes the implementation's role instead of what the code is about,
and it drifts (the same trio was once `goals/`, `loop-mode/`, `plan-mode/`).

What a feature directory shares is `runtime.ts` (the state machine class that
owns state and decisions), `index.ts` (the barrel) and `*.test.ts` beside their
source. The pure-domain modules are named after what they hold, and how many
there are follows the feature — `plans/` has a single `state.ts`, while `loops/`
splits its domain across `limits.ts`, `condition.ts` and `ralph.ts`. Do not
assume a `state.ts`.

A rename must repoint `scripts/audit-coverage.ts`. Its floors are path-keyed, and
it does fail loudly on a stale one (`NO COVERAGE DATA` / `NOT MEASURED`, exit 1)
— but only the CI coverage job runs it, so the rename is green locally until CI
runs. Repoint the floors in the same commit.
