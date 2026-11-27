# AGENTS.md — apps/oh-my-agent

Working contract for the **Oma CLI** (`oma`). This is the runtime agent
core that the Product Backend spawns for each Run.

## What this app is

- A run-centric CLI agent in four modes: `print`, `json`, `acp`, and
  interactive `tui`.
- `acp` mode is the product integration surface (ADR 0039/0040): the backend
  ACP client spawns `oma --mode acp` and speaks Agent Client Protocol JSON-RPC
  over stdio.
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
  cli.ts                         # entrypoint
  main.ts                        # argument parsing + lazy mode dispatch
  version.ts                     # zero-dep package version reader
  core/
    runtime/README.md            # reading order + file map (start here)
    runtime/create-runtime.ts    # createOmaRuntime: the per-Run facade
    runtime/run-runtime.ts       # assembleRunRuntime: Run assembly coordinator
    runtime/run-tools.ts         # native tool table, timeouts, MCP mount stage
    runtime/run-permissions.ts   # ask/deny/auto permission gates & classifier
    runtime/run-delegation.ts    # subagent executor, workflow script runner, hub
    runtime/agent-loop.ts        # createOmaSession (the loop factory)
    runtime/agent-loop-runner.ts # model-turn retry loop & runLoop driver
    runtime/agent-loop-lifecycle.ts # start, resume, background hold, steer, finalize
    runtime/plugin.ts            # Plugin + hooks + validatePlugins
    runtime/plugin-runtime.ts    # runtime capabilities injected into hooks
    runtime/tool-filter.ts       # --tools whitelist/blacklist
  modes/
    print-mode.ts
    json-mode.ts
    acp/acp-mode.ts              # ACP session/run lifecycle (stdout is protocol-only)
    acp/acp-protocol.ts          # ACP wire mapping, MCP-over-ACP, approvals
    tui/                         # interactive TUI (ask-panel + ask-panel-model, ...)
  core/tools/                    # native tools (bash, grep, todo, eval, browser, ...)
  core/session/                  # CLI-owned session files (JSONL): paths, file, fork, markers
  core/loops/                    # loop mode: limits, condition, ralph
  core/goals/                    # goal mode state machine + tool
  core/plans/                    # plan mode state machine + prompts
  core/gateway/                  # `oma gateway` daemon, supervisor, doctor, artifact
  core/settings/                 # .oma/settings.json + workspace context
  core/plugins/                  # plugin loading/trust
  core/memory/                   # autonomous memory + vector memory bridge
```

## Cross-file imports

- **Internal cross-file imports are relative with `.js` extension**
  because the package compiles to ESM under `NodeNext`
  (`import { runCli } from "./main.js"`). Do not use extensionless
  relative imports.
- **Workspace packages are imported by package name**
  (`@chengchenccc/message`, `@chengchenccc/ai`, `@chengchenccc/sandbox`, ...).
  Never use monorepo paths like `../../packages/...`.
- **One-way runtime boundary (enforced by `bun run audit`):**
  `src/core/runtime/` must never import `modes/`, `core/gateway/`, or `core/update/`.
- Example cross-file doc entry point to read first:
  [docs/README.md](../../docs/README.md).

## Rules and invariants

- `backend` is the source of truth for product state; `oma` is the runtime
  only. ACP mode must never write product DB.
- In `acp` mode, **stdout is protocol-only** JSON-RPC. No logs or debug text on
  stdout; logs go to stderr.
- Tool filtering happens at the final tool table (native + MCP + plugins)
  in run-runtime. The model never sees a filtered tool.
- Product-injected tools mount via MCP-over-ACP and take priority over native
  tools (e.g. MCP `todo_write` suppresses native todo).
- Plugin hooks receive a `runtime` (rt) parameter with stream/model/store
  abilities — no `pi`/jiti dynamic loading.
- `RunRuntimeDeps` carries env/test knobs; backend forwards allowlisted
  `OMA_FAKE_*` through the ACP transport for in-process smoke tests.
- No `postinstall` script: gateway artifacts are fetched explicitly via
  `oma gateway fetch` (or `scripts/install.sh`). `puppeteer-core` is an
  optional dependency loaded lazily by the `browser` tool.

## Known pitfalls

- **Bun timers in `Promise.race` must be cleared** or the process lingers
  after the race settles (15s hang).
- **Bun.spawn throws ENOENT on a missing cwd.**
- **ACP cancellation/eof discipline:** `runPrompt` holds a single-flight lock
  and settles on `cancel` / stream EOF so parked approvals fail closed.
- **`StdioClientTransport` does not inherit process env.** Custom test knobs
  (`MCP_ECHO_*`) must travel via `.mcp.json` `env`, not via the parent
  process environment.
- **Default model must come from the run's model binding** (`run model`),
  not `catalog[0]`. Budget + summarizer bind to the run model.

## Related docs

- [docs/README.md](../../docs/README.md) — repo wiki front door
- [docs/architecture/oma-runtime.md](../../docs/architecture/oma-runtime.md) — the oma runtime spec
- [docs/architecture/skills-and-plugins.md](../../docs/architecture/skills-and-plugins.md) — skills & plugin trust matrix
- [docs/architecture/system-overview.md](../../docs/architecture/system-overview.md) — system & backend overview

## Review checklist

1. `bun run typecheck` passes.
2. `bun run lint` passes.
3. `bun run test` passes.
4. ACP stdout remains protocol-only; no stray `console.log`.
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
