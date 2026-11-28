---
title: Oma Runtime
description: In-repo oma CLI and agent runtime — 4 execution modes (print/json/acp/tui), createOmaSession & assembleRunRuntime, native tools & MCP mount, delegation fan-out, autonomous memory, TUI layering, and goals/loops/plans
tags: [oma, runtime, tools, tui, delegation]
---

# Oma Runtime

`apps/oh-my-agent` (`@chengchenccc/oh-my-agent`) is CrewDesk's in-repo coding agent CLI and runtime. It runs standalone (`print`, `json`, `tui` modes) and as a Product Backend harness (`oma --mode acp`). Core runtime modules (`src/core/runtime/`) are strictly decoupled from `modes/`, `core/gateway/`, and `core/update/` (enforced by `scripts/audit-contracts.ts`), and depend only on `@chengchenccc/message`'s `ChatModel` contract.

## Authoritative files

- `apps/oh-my-agent/src/cli.ts`, `main.ts`, `cli/args.ts`, `cli/doctor-command.ts`, `cli/setup-wizard.ts` — CLI entrypoint, reserved subcommands (`gateway`, `update`, `doctor`, `setup`), flag parsing
- `apps/oh-my-agent/src/modes/print-mode.ts` & `json-mode.ts` — One-shot headless modes (`--max-turns`, `--max-budget-usd` with provider-side dynamic `maxTokens` capping, `--output-schema`, `--effort`)
- `apps/oh-my-agent/src/modes/acp/acp-mode.ts` & `acp-protocol.ts` — ACP stdio server (`oma --mode acp`)
- `apps/oh-my-agent/src/modes/tui/tui-mode.ts` & `tui-transcript-reconciler.ts` & `tui-frame-provider.ts` — Interactive TUI surface
- `apps/oh-my-agent/src/core/runtime/agent-loop.ts` & `agent-loop-runner.ts` — `createOmaSession()` model+tool loop
- `apps/oh-my-agent/src/core/runtime/create-runtime.ts` & `run-runtime.ts` — `createOmaRuntime()` & `assembleRunRuntime()`
- `apps/oh-my-agent/src/core/runtime/run-tools.ts` & `apps/oh-my-agent/src/core/tools/` — Native tools & `mcp-mount.ts`
- `apps/oh-my-agent/src/core/delegation/executor.ts` & `tool.ts` & `roles.ts` — Subagent fan-out (`task`, `hub`, `yield`)
- `apps/oh-my-agent/src/core/orchestrate/script-runner.ts` & `tool.ts` — Sandboxed dynamic orchestration engine (`orchestrate` tool / `/orchestrate`)
- `apps/oh-my-agent/src/core/memory/autonomous-memory.ts` & `learn.ts` & `vector-memory.ts` — Autonomous memory & `.oma/memory/memory.db`
- `apps/oh-my-agent/src/core/goals/runtime.ts`, `core/loops/runtime.ts`, `core/plans/runtime.ts` — TUI autonomous turn drivers
- `apps/oh-my-agent/src/protocol/mapping.ts` — `mapRunEvent()` & `forWire()` (strips raw tool inputs on wire)

## CLI Entrypoints & 4 Execution Modes

Reserved subcommands `oma gateway <up|down|fetch|status|doctor|passwd>`, `oma update [--check] [--version]`, `oma doctor [--json]`, and `oma setup` dispatch before the flag parser (`exit 0` ok, `1` runtime error, `2` `UsageError`); on an interactive TTY with 0 configured models, `oma` auto-launches the setup wizard. Key flags: `-p <prompt>`, `--mode <print|json|tui|acp>` (defaults to `tui` when TTY without `-p`, else `print`), `--list-models`, `--model <provider/model>`, `--effort <none|low|high|max>`, `--max-turns <n>`, `--max-budget-usd <n>`, `--output-schema <file|json>`, `-w / --worktree [<name>]` (isolates runs in `.oma/worktrees/<name>` on branch `oma/<name>` with clean auto-removal), `--session <id>`, `--continue/-c`, `--permission <ask|auto|deny|off|yolo>`, `--yolo`, `--read-only`, `--tools <csv>` (`name` whitelist or `!name` blacklist).

| Mode | Lifecycle | Approvals & Memory | Output |
|---|---|---|---|
| `print` | 1 Run, persists turn on `completed` | `denyAllApprovals`; awaits `memoryLearning()` | Final assistant text to stdout |
| `json` | 1 Run, persists turn on `completed` | `denyAllApprovals`; awaits `memoryLearning()` | `{type:"event"}` + `{type:"outcome"}` JSONL |
| `acp` | 1 process per Product Run over stdio (`ndJsonStream`) | `session/requestPermission` (fail-closed, 24h default); `autonomousMemory: false`; honors `OMA_DISABLED_TOOLS` & MCP-over-ACP | Standard `session/update` + `_oma/update` |
| `tui` | 1 process = N consecutive Runs over 1 session file; shared `COORDINATION_SCOPE = tui-<pid>` | Interactive bottom-slot panels (`AskPanel` / approval); autonomous memory on | Differential terminal UI (`packages/tui`) |

## Core Runtime & Agent Loop

- **`createOmaSession()` (`agent-loop.ts`, `agent-loop-runner.ts`):**
  - Validates plugins (`validatePlugins`), enforces single-flight per session, emits heartbeats every `15_000 ms`.
  - **Atomic tool-batch persistence (`buildToolBatch`):** writes `assistant(tool_use)` + all `tool_result`s together so dangling `tool_use` blocks never enter the session store.
  - **HITL durability (`onParkedTurn`):** flushes parked state before tool execution so crash/HITL resume (`_meta["my-agent-team/resume"]`) injects decided `ask` answers as synthetic `tool_result`s and re-runs `allow`ed tools without re-prompting (ADR 0038).
  - **TTSR stream rules:** `.oma/rules/*.md` regex matches abort and discard partial streaming text, inject `<system-reminder>`, and retry within the turn (`maxInjections: 1`).
  - **Continuation & supervision:** `maxForceContinues: 4` bounds `beforeStop` vetoes and `max_tokens`/`pause_turn` continuations; `holdForBackground` keeps a turn open while background jobs/subagents run, waking on settle or steer.
- **`createOmaRuntime()` (`create-runtime.ts`) & `assembleRunRuntime()` (`run-runtime.ts`):**
  - Constants: `DEFAULT_MODEL_TIMEOUT_MS = 300_000`, `DEFAULT_MAX_STEPS = 500`, `SUMMARY_MAX_TOKENS = 4_096`.
  - `run()` is single-use and resolves only after reaching a safe steer boundary (`message_start` or `agent_end`). Merges subagent usage into `BackendRunOutcome.usage`. `close()` bounds MCP/store teardown to `2 s`.
  - **Workspace settings trust:** standalone mode merges 3 settings tiers (`~/.oma/settings.json` → `.oma/settings.json` → `.oma/settings.local.json`), requiring `isFileTrusted` for security-weakening workspace knobs (`yolo`, `browserLocalNetwork`, `permissions.allow`), while `permissions.deny` is always honored (`deny` always beats `allow`; bash prefix allow rules reject shell compound/substitution syntax); ACP/product runs honor **only** `bashSandbox` from workspace settings.
- **Wire boundary (`protocol/mapping.ts`):** `forWire()` strips `data.input` on `tool_execution_start`, forwarding only sanitized `presentation` + `activity` (ADR 0033); approval requests intentionally retain `input` so operators can inspect what they approve.

## Native Tools & MCP Mount (`core/tools/`, `run-tools.ts`)

Wrapper backstops: `DEFAULT_NATIVE_TOOL_TIMEOUT_MS = 30_000`, `MAX_BASH_TIMEOUT_MS = 600_000`, `MAX_EVAL_TIMEOUT_MS = 600_000`, globally capped by `OMA_MAX_TOOL_TIMEOUT_MS`.

- **Always mounted (read-only + read-write):** `read` (`256 KiB` cap, appends `[fingerprint <12hex>]` when `editFreshness = "require"`), `read_image`, `ls`, `tree`, `glob` (500-match cap, rejects `/` prefix and `..`), `grep` (`rg -n --color=never -e <pattern> -- <validatedPath>` to block `--pre` RCE).
- **`read_write` only:** `write` / `edit` (`WorkspaceSandbox`, `PROTECTED_FILES`, `OMA_{DENY,ALLOW}_WRITE_PATHS`, fingerprint freshness, plan-mode guard), `bash` (30s–600s, `10 MiB` cap, `deniedCommand`, quote-aware `writeEscapeOf`, secret-stripped env, optional `BashSandbox`, `async: true` bg jobs in `CoordinationRegistry`), plus when not in plan mode: `eval` (`@chengchenccc/sandbox`, forwards isolation when `bashSandbox` active) and `browser` (SSRF-guarded; `OMA_BROWSER_LOCAL_NETWORK=1` allows RFC1918/loopback while keeping metadata blocked).
- **Web (unless `OMA_DISABLE_WEB=1`):** `web_search` (DuckDuckGo HTML) and `web_fetch` (`512 KiB`, 5 redirects max, 10s timeout, `assertSafeUrlDeep` on every hop).
- **Conditional native tools:** `skill` (`progressive-skill`), `ask_question` & `todo_{write,read}` (automatically yielded when Product MCP supplies them), standalone memory tools (`learn`, `manage_skill`, plus `recall`/`retain` unless `OMA_VECTOR_MEMORY=0`).
- **MCP mount (`mcp-mount.ts`):** mounts `.mcp.json` (trust-gated in standalone) + plugin MCP configs as `mcp__<sanitizedServer>__<tool>`, skipping server names already served via MCP-over-ACP. Native tools win collisions. `${VAR}` expansion is strictly allowlisted via `OMA_MCP_EXPANDABLE_VARS`. Timeouts: mount `30 s`, call `120 s` (`OMA_MCP_TIMEOUT_MS`).

## Delegation Fan-Out & Dynamic Orchestration (`core/delegation/`, `core/orchestrate/`)

> **Distinction from Product Backend `Workflow`:** Product Backend [Workflow Engine](./workflow.md) (`packages/workflow`, `*.workflow.json`) is a **declarative, persistent, triggerable DAG** with SQLite execution history, cron/webhook triggers, rework budgets, and human-form gates. Oma's **`orchestrate`** (`core/orchestrate/`) is **in-run programmatic JS orchestration** — ephemeral code control flow (`agent()`, `parallel()`, read-only `tool()`, `phase()`) for multi-stage pipelines, fix-until-pass loops, and large map-reduce sweeps within a single session.

- **`task` tool:** single `{ agent, prompt, schema?, background?, resume? }` or batch `{ context, tasks[] }` (up to `MAX_BATCH_TASKS = 64`), capped at `maxConcurrent = 8`, `maxTotal = 64`, `SUBAGENT_MAX_STEPS = 500`, optional `workflowBudgetTokens`.
- **Roles:** builtins `explore` and `plan` (read-only: `read`, `grep`, `glob`, `tree`, `read_image`) and `task` (full subagent file tools); custom roles in `.oma/agents/<name>.md` (disabled in `read_only` workspaces).
- **Structured yield:** schema-bearing subagents receive `yield` validated via JSON Schema (`{ terminate: true }` on accept); oversized outputs spill to `.oma/workflow/`.
- **`hub` tool (`core/coordination/hub-tool.ts`):** unified `list` / `get` / `wait` / `stop` / `steer` control over subagents and async bash/eval jobs.
- **`orchestrate` tool & TUI `/orchestrate` (alias `/workflow`) (`core/orchestrate/script-runner.ts`):** spawns an isolated Bun child (Linux `bwrap --ro-bind / / --unshare-pid --unshare-net --tmpfs /root --tmpfs /home --die-with-parent`), runs top-level-await JS in `vm.createContext` with `codeGeneration: { strings: false, wasm: false }` (30s sync CPU spin cap, 30 min default wall-clock cap, live `AbortSignal` teardown), and bridges NDJSON stdio IPC (`__OMA_ORCH_IPC__:`) for `agent(prompt, { role?, model?, tools?, schema?, label?, timeoutMs? })`, `parallel(items, fn, { concurrency? })` (alias `pipeline`), read-only `tool('glob'|'grep'|'read'|'ls'|'tree', input)`, `phase(name, fn)`, and `console.log`. Reusable scripts save under `.oma/orchestrations/<name>.js` (legacy read fallback to `.oma/workflow/<name>.js`). TUI `/orchestrate` persists results back into the session transcript (spilling >8 KB outputs to `.oma/runs/`).

## Autonomous Memory, TUI Layering & Turn Drivers

- **Autonomous memory (`core/memory/`):** runs post-turn in standalone root runs (`status === "completed"`, `agentDepth === 0`, `toolCalls >= 5`, `OMA_MEMORY_EXTRACT !== "0"`). Extracts facts (`8_000`-char budget, 60s timeout) → secret-redacts → deduplicates → writes `.oma/memory/facts/<runId>.md` + best-effort `.oma/memory/memory.db` (fastembed ONNX or FTS-only fallback) → consolidates `memory_summary.md` & `MEMORY.md`. Swallows all errors. Explicit `learn` writes `.oma/memory/learned.md` (max 100 entries).
- **TUI layering (`modes/tui/`, `packages/tui`, ADR 0028):** strictly separates live **chrome** (pinned above editor, 100ms shimmer, todo + live subagents, permission/effort/MCP-error chips and live USD spend) from append-only immutable **transcript** (`tui-transcript-reconciler.ts`, scrollback cleared only on width change). `TuiRenderShell` coalesces live repaints at `50 ms`; bottom slot dynamically docks `AskPanel` / approvals (clamped to 70% viewport height). Key shortcuts: `Shift+Tab` cycles `ask → auto → plan`, `Ctrl+V` pastes clipboard images, `Ctrl+P` model picker, `Ctrl+R` history search. Before each user turn, `core/session/checkpoints.ts` asynchronously captures a git shadow tree (temporary `GIT_INDEX_FILE`, never touching `.git/index` or gitignored files) powering `/diff` and `/rewind`, alongside `/cost`, `/effort`, `/export`, `/init`, and `/doctor`.
- **TUI turn drivers (`core/{goals,loops,plans}/`):**
  - `GoalRuntime`: autonomous objective loop with token/wall-clock tracking, auto-pausing after `NO_PROGRESS_LIMIT = 3` tool-less turns or errors.
  - `LoopRuntime`: in-memory post-turn re-submitter (`prompt | compact | reset | ralph`) bounded by count/duration and `--while`/`--until` shell condition.
  - `PlanRuntime`: read-only planning state machine whose `writeGuard` limits `write`/`edit` solely to `planPath`, with optional `planModel` switching.

## See also

- [ACP Backend Contract](./acp-backend-contract.md) — How Product Backend drives `oma --mode acp`
- [Skills & Plugins](./skills-and-plugins.md) — Plugin trust matrix, progressive skills, and permission gates
- [Models & Providers](./models-and-providers.md) — Provider protocols and `$OMA_HOME/models.yml`
- [Compaction](./compaction.md) — 4-trigger compaction and read-side tool pruning
- [Security Model](./security-model.md) — Path jail, URL guard, and `bwrap`/`seatbelt` bash sandboxes
