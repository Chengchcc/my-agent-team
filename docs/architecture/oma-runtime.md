---
title: Oma Runtime
description: In-repo oma CLI and agent runtime — 4 execution modes (print/json/acp/tui), setup/doctor/worktree CLI, 3-tier settings & permission rules, dynamic USD budget capping, createOmaSession & assembleRunRuntime, native tools & MCP mount, delegation & dynamic orchestration, autonomous memory, shadow checkpoints, TUI layering, and goals/loops/plans
tags: [oma, runtime, tools, tui, delegation, orchestrate, settings, worktree]
---

# Oma Runtime

`apps/oh-my-agent` (`@chengchenccc/oh-my-agent`) is CrewDesk's in-repo coding agent CLI and runtime. It runs standalone (`print`, `json`, `tui` modes) and as a Product Backend harness (`oma --mode acp`). Core runtime modules (`src/core/runtime/`) are strictly decoupled from `modes/`, `core/gateway/`, and `core/update/` (enforced by `scripts/audit-contracts.ts`), and depend only on `@chengchenccc/message`'s `ChatModel` contract.

## Authoritative files

- `apps/oh-my-agent/src/cli.ts`, `main.ts`, `cli/args.ts`, `cli/initial-input.ts` — CLI entrypoint, lazy mode dispatch, flag parsing, piped stdin & `--output-schema` loading
- `apps/oh-my-agent/src/cli/setup-wizard.ts`, `cli/doctor-command.ts`, `cli/worktree.ts`, `cli/gateway-commands.ts`, `cli/update-command.ts` — Reserved subcommands (`setup`, `doctor`, `gateway`, `update`) and `-w`/`--worktree` isolation
- `apps/oh-my-agent/src/modes/print-mode.ts` & `json-mode.ts` — One-shot headless modes (`--max-turns`, `--max-budget-usd` dynamic `maxTokens` capping, `--output-schema`, `--effort`)
- `apps/oh-my-agent/src/modes/acp/acp-mode.ts` & `acp-protocol.ts` — ACP stdio server (`oma --mode acp`)
- `apps/oh-my-agent/src/modes/tui/tui-mode.ts`, `tui-commands.ts`, `tui-commands-session.ts`, `tui-transcript-reconciler.ts`, `tui-frame-provider.ts`, `approval-panel.ts`, `pty-console.ts` — Interactive TUI surface
- `apps/oh-my-agent/src/core/runtime/agent-loop.ts` & `agent-loop-runner.ts` & `agent-loop-run.ts` — `createOmaSession()` model+tool loop
- `apps/oh-my-agent/src/core/runtime/create-runtime.ts` & `run-runtime.ts` — `createOmaRuntime()` & `assembleRunRuntime()`
- `apps/oh-my-agent/src/core/runtime/run-permissions.ts`, `permission-rules.ts`, `permission-classifier.ts`, `approval.ts` — Permission modes, pattern rules, classifier, HITL deadlines
- `apps/oh-my-agent/src/core/runtime/cost.ts` & `model-effort.ts` — Live USD spend accounting, `computeBudgetMaxTokens()`, reasoning effort mapping
- `apps/oh-my-agent/src/core/settings/project-settings.ts` — 3-tier settings merge (`user → project → local`), trust gating, `resolveRuntimeKnobs()`
- `apps/oh-my-agent/src/core/session/session-file.ts`, `checkpoints.ts`, `export-markdown.ts`, `session-fork.ts` — JSONL session persistence, git shadow checkpoints, Markdown export, branch forking
- `apps/oh-my-agent/src/core/runtime/run-tools.ts` & `apps/oh-my-agent/src/core/tools/` — Native tools & `mcp-mount.ts`
- `apps/oh-my-agent/src/core/delegation/executor.ts` & `tool.ts` & `roles.ts` — Subagent fan-out (`task`, `hub`, `yield`)
- `apps/oh-my-agent/src/core/orchestrate/script-runner.ts` & `tool.ts` — Sandboxed dynamic orchestration engine (`orchestrate` tool / `/orchestrate`)
- `apps/oh-my-agent/src/core/memory/autonomous-memory.ts` & `learn.ts` & `vector-memory.ts` — Autonomous memory & `.oma/memory/memory.db`
- `apps/oh-my-agent/src/core/goals/runtime.ts`, `core/loops/runtime.ts`, `core/plans/runtime.ts` — TUI autonomous turn drivers
- `apps/oh-my-agent/src/protocol/mapping.ts` — `mapRunEvent()` & `forWire()` (strips raw tool inputs on wire)

## CLI Entrypoints, Subcommands & 4 Execution Modes

Reserved subcommands dispatch before the flag parser (`exit 0` ok, `1` runtime error, `2` `UsageError`):

- **`oma setup`** (`cli/setup-wizard.ts`): interactive provider & API key onboarding writing `$OMA_HOME/models.yml` (default `~/.oma/models.yml`) while preserving existing providers. On an interactive TTY with 0 available models, bare `oma` auto-launches the wizard before entering TUI.
- **`oma doctor [--json]`** (`cli/doctor-command.ts`): checks Bun runtime, configured model catalog & credentials, core CLI tools (`git`, `rg`), OS bash sandbox availability (`bwrap`/`sandbox-exec`), workspace settings, and `.mcp.json` trust status.
- **`oma gateway <up [-d]|down|fetch|status|doctor|passwd>`** (`cli/gateway-commands.ts`): manages the detached Product Backend + Web gateway bundle (see [Operations & Gateway](./operations-and-gateway.md)).
- **`oma update [--check] [--version <v>]`** (`cli/update-command.ts`): checks and upgrades the CLI + gateway release bundle.

**Key CLI flags (`cli/args.ts`):** `-p <prompt>`, `--mode <print|json|tui|acp>` (defaults to `tui` when TTY without `-p`, else `print`), `--list-models`, `--model <provider/model>`, `--effort <none|low|high|max>`, `--max-turns <n>`, `--max-budget-usd <n>`, `--output-schema <file|json>`, `-w / --worktree [<name>]`, `--session <id>`, `--continue` / `-c`, `--permission <ask|auto|deny|off|yolo>`, `--yolo`, `--read-only`, `--tools <csv>` (`name` whitelist or `!name` blacklist). Piped stdin is merged ahead of `-p` in headless modes (`cat diff | oma -p "Review"`, bounded to `16 MiB`).

| Mode | Lifecycle | Approvals, Budget & Memory | Output |
|---|---|---|---|
| `print` | 1 Run, persists turn on `completed` | `denyAllApprovals`; honors `--max-turns`, `--max-budget-usd`, `--output-schema`; awaits `memoryLearning()` | Final assistant text to stdout |
| `json` | 1 Run, persists turn on `completed` | Same as `print`; budget/schema errors emit terminal failed outcome | `{type:"event"}` + `{type:"outcome"}` JSONL |
| `acp` | 1 process per Product Run over stdio (`ndJsonStream`) | `session/requestPermission` (fail-closed, 24h default); `autonomousMemory: false`; honors `OMA_DISABLED_TOOLS` & MCP-over-ACP | Standard `session/update` + `_oma/update` |
| `tui` | 1 process = N consecutive Runs over 1 session file; shared `COORDINATION_SCOPE = tui-<pid>` | Interactive bottom-slot panels (`AskPanel` / `ApprovalPanel`); live USD spend; autonomous memory on | Differential terminal UI (`packages/tui`) |

## Git Worktree Isolation (`cli/worktree.ts`)

Passing `-w` / `--worktree [<name>]` isolates a standalone CLI run (`tui`, `print`, or `json`) in its own git worktree so parallel `oma` processes never collide on one working tree:

- Creates (or reuses) `<repoRoot>/.oma/worktrees/<name>` (auto-named `wt-<YYYYMMDD>-<4hex>` when omitted) on branch `oma/<name>`, and appends `.oma/worktrees/` to repo-local `.git/info/exclude` so the parent repository's `git status` and tracked `.gitignore` stay untouched.
- Multi-word prompts after `-w` (e.g. `oma -w "fix auth bug"`) are not swallowed as worktree names — only valid slug tokens (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, no `..`) bind as `<name>`.
- On exit, `exitWorktree()` automatically removes freshly created worktrees with zero new commits and a clean status (along with the empty branch); dirty, committed, or reused worktrees are preserved with `git merge` / `git worktree remove` instructions on stderr.

## 3-Tier Settings & Cost / Budget Guard

### Settings Layering (`core/settings/project-settings.ts`)

Standalone modes merge three JSON tiers in increasing precedence (`loadProjectSettings(root)`):

| Tier | Path | Trust Policy |
|---|---|---|
| 1. User (global) | `$OMA_HOME/settings.json` (or `~/.oma/settings.json`) | Always trusted |
| 2. Project (shared) | `<workspace>/.oma/settings.json` | Trust-gated via `<agentDir>/trusted-plugins.json` |
| 3. Local (machine) | `<workspace>/.oma/settings.local.json` | Trust-gated; auto-trusted when written by `oma`; protected in `PROTECTED_FILES` & `BWRAP_RO_WORKSPACE_FILES` |

- **Merge rules:** scalar keys (`model`, `reasoningEffort`, `permissionMode`, `maxSteps`, `bashSandbox`, timeouts, etc.) override tier-by-tier; `prune` and `memoryVector` shallow-merge; `permissions.allow` and `permissions.deny` union (deduped) across tiers.
- **Security invariants:** untrusted project/local files downgrade `permissionMode: "yolo"` → `"ask"`, drop `browserLocalNetwork: true`, and strip `permissions.allow`, while always honoring `permissions.deny` (fail-closed). Writing a benign key into a previously untrusted `.oma/settings.json` (e.g. `saveProjectModel`) strips pre-existing untrusted weakening keys before marking the file trusted. ACP/product runs ignore all workspace settings **except** `bashSandbox`.

### Cost Accounting & Dynamic Budget Capping (`core/runtime/cost.ts`, `modes/print-mode.ts`)

- `calculateUsageCostUsd()` computes estimated USD spend from per-1M-token catalog `ModelCost` (`input`, `output`, `cacheRead`, `cacheWrite`).
- In headless runs with `--max-budget-usd`, `createBudgetGuard()` wraps `ModelRuntime.stream()` at the single provider boundary (covering main loop, compaction summaries, subagents, and memory extraction):
  1. Before every outgoing call, `computeBudgetMaxTokens(remainingUsd, callCost, streamOpts?.maxTokens)` dynamically clamps `opts.maxTokens` to the maximum output tokens affordable under the remaining USD budget (honored downward-only across all three wire protocols in `@chengchenccc/ai`).
  2. When remaining budget is exhausted or cannot fund 1 output token (`0`), the wrapper throws a non-retryable `ProviderError(..., "quota")` before contacting the provider and stops the runtime.
  3. Live spend accumulates directly from streamed `chunk.usage` chunks (single source of truth; zero double-counting).

## Core Runtime & Agent Loop

- **`createOmaSession()` (`agent-loop.ts`, `agent-loop-runner.ts`, `agent-loop-run.ts`):**
  - Validates plugins (`validatePlugins`), enforces single-flight per session, emits heartbeats every `15_000 ms`.
  - **Atomic tool-batch persistence (`buildToolBatch`):** writes `assistant(tool_use)` + all `tool_result`s together so dangling `tool_use` blocks never enter the session store.
  - **HITL durability (`onParkedTurn`):** flushes parked state before tool execution so crash/HITL resume (`_meta["my-agent-team/resume"]`) injects decided `ask` answers as synthetic `tool_result`s and re-runs `allow`ed tools without re-prompting (ADR 0038).
  - **TTSR stream rules:** `.oma/rules/*.md` regex matches abort and discard partial streaming text, inject `<system-reminder>`, and retry within the turn (`maxInjections: 1`).
  - **Continuation & supervision:** `maxForceContinues: 4` bounds `beforeStop` vetoes and `max_tokens`/`pause_turn` continuations; `holdForBackground` keeps a turn open while background jobs/subagents run, waking on settle or steer.
- **`createOmaRuntime()` (`create-runtime.ts`) & `assembleRunRuntime()` (`run-runtime.ts`):**
  - Constants: `DEFAULT_MODEL_TIMEOUT_MS = 300_000`, `DEFAULT_MAX_STEPS = 500`, `SUMMARY_MAX_TOKENS = 4_096`.
  - `run()` is single-use and resolves only after reaching a safe steer boundary (`message_start` or `agent_end`). Merges subagent usage into `BackendRunOutcome.usage`. `close()` bounds MCP/store teardown to `2 s`.
- **Wire boundary (`protocol/mapping.ts`):** `forWire()` strips `data.input` on `tool_execution_start`, forwarding only sanitized `presentation` + `activity` (ADR 0033); approval requests intentionally retain `input` so operators can inspect what they approve.

## Native Tools & MCP Mount (`core/tools/`, `run-tools.ts`)

Wrapper backstops: `DEFAULT_NATIVE_TOOL_TIMEOUT_MS = 30_000`, `MAX_BASH_TIMEOUT_MS = 600_000`, `MAX_EVAL_TIMEOUT_MS = 600_000`, globally capped by `OMA_MAX_TOOL_TIMEOUT_MS`.

- **Always mounted (read-only + read-write):** `read` (`256 KiB` cap, appends `[fingerprint <12hex>]` when `editFreshness = "require"`), `read_image`, `ls`, `tree`, `glob` (500-match cap, rejects `/` prefix and `..`), `grep` (`rg -n --color=never -e <pattern> -- <validatedPath>` to block `--pre` RCE).
- **`read_write` only:** `write` / `edit` (`WorkspaceSandbox`, `PROTECTED_FILES`, `OMA_{DENY,ALLOW}_WRITE_PATHS`, fingerprint freshness, plan-mode guard), `bash` (30s–600s, `10 MiB` cap, `deniedCommand`, quote-aware `writeEscapeOf`, secret-stripped env, optional `BashSandbox`, `async: true` bg jobs in `CoordinationRegistry`, `pty: true` interactive console in TUI), plus when not in plan mode: `eval` (`@chengchenccc/sandbox`, forwards isolation when `bashSandbox` active) and `browser` (SSRF-guarded; `OMA_BROWSER_LOCAL_NETWORK=1` allows RFC1918/loopback while keeping metadata blocked).
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

## Sessions, Shadow Checkpoints, Autonomous Memory & TUI

- **Session store (`core/session/`):** JSONL files under `<agentDir>/sessions/--<encoded-cwd>--/` (`OMA_SESSION_DIR` overrides flat). Stores messages, titles, summaries, branch `parentId` chains, goal/plan state, and checkpoint tree SHAs. `/resume` lists sessions across workspaces (sorted reverse-chronologically, highlighting current workspace, supporting live filter and `Ctrl+D` delete); `/fork` and idle `Esc×2` fork at any historical node; `/export [<path>]` (`export-markdown.ts`) renders the conversation transcript to Markdown.
- **Git shadow checkpoints (`core/session/checkpoints.ts`):** before each TUI user turn, `captureCheckpointTreeAsync()` snapshots tracked + untracked non-ignored files into a git tree SHA using a temporary `GIT_INDEX_FILE` via `Bun.spawn` (never blocking the TUI event loop and never touching `.git/index`, git stash, or ignored files). Powers `/diff [<file> | restore <file>]` and `/rewind [<turn>]`.
- **Autonomous memory (`core/memory/`):** runs post-turn in standalone root runs (`status === "completed"`, `agentDepth === 0`, `toolCalls >= 5`, `OMA_MEMORY_EXTRACT !== "0"`). Extracts facts (`8_000`-char budget, 60s timeout) → secret-redacts → deduplicates → writes `.oma/memory/facts/<runId>.md` + best-effort `.oma/memory/memory.db` (fastembed ONNX or FTS-only fallback) → consolidates `memory_summary.md` & `MEMORY.md`. Swallows all errors. Explicit `learn` writes `.oma/memory/learned.md` (max 100 entries).
- **TUI layering (`modes/tui/`, `packages/tui`, ADR 0028):** strictly separates live **chrome** (pinned above editor, 100ms shimmer, todo + live subagents, permission/effort/MCP-error chips and live USD spend) from append-only immutable **transcript** (`tui-transcript-reconciler.ts`, scrollback cleared only on width change). `TuiRenderShell` coalesces live repaints at `50 ms`; bottom slot dynamically docks `AskPanel` / `ApprovalPanel` (clamped to 70% viewport height; `[p]` persists scoped permission rules to `.oma/settings.local.json`).
  - **Keybindings & inline prefixes:** `Shift+Tab` cycles `ask → auto → plan`, `Ctrl+P` model picker, `Ctrl+R` history search, `Ctrl+V` clipboard image paste, `Ctrl+O` tool detail, `Ctrl+T` thinking toggle, `Esc` abort live run (`Esc×2` branch-tree fork), `!cmd` local shell escape, `@file` fuzzy file picker.
  - **Slash commands (`tui-commands.ts`, `tui-commands-session.ts`):**
    - *Session & checkpoints:* `/session`, `/diff`, `/rewind`, `/export`, `/resume`, `/new`, `/fork`, `/compact`, `/clear`
    - *Config, safety & diagnostics:* `/settings`, `/permission [mode|allow|deny|rules|clear-rules]`, `/model`, `/effort`, `/cost`, `/doctor`, `/init`, `/mcp`, `/plugin`, `/skill`, `/memory`
    - *Execution & view:* `/plan`, `/goal`, `/loop`, `/orchestrate` (alias `/workflow`), `/abort`, `/thinking`, `/tools`, `/paste`, `/help`, `/exit` (alias `/quit`), plus auto-registered `/skill:<name>` commands (legacy `/rename`, `/delete`, `/plan-review`, `/guided-goal`, `/marketplace` remain callable while hidden from autocomplete).
- **TUI turn drivers (`core/{goals,loops,plans}/`):**
  - `GoalRuntime`: autonomous objective loop with token/wall-clock tracking, auto-pausing after `NO_PROGRESS_LIMIT = 3` tool-less turns or errors.
  - `LoopRuntime`: in-memory post-turn re-submitter (`prompt | compact | reset | ralph`) bounded by count/duration and `--while`/`--until` shell condition (honoring workspace `permissionMode` + `bashSandbox` confinement).
  - `PlanRuntime`: read-only planning state machine whose `writeGuard` limits `write`/`edit` solely to `planPath`, with optional `planModel` switching.

## See also

- [ACP Backend Contract](./acp-backend-contract.md) — How Product Backend drives `oma --mode acp`
- [Skills & Plugins](./skills-and-plugins.md) — Plugin trust matrix, progressive skills, permission modes & pattern rules
- [Models & Providers](./models-and-providers.md) — Provider protocols, `opts.maxTokens` cap, and `$OMA_HOME/models.yml`
- [Compaction](./compaction.md) — 4-trigger compaction and read-side tool pruning
- [Security Model](./security-model.md) — Path jail, URL guard, and `bwrap`/`seatbelt` bash sandboxes
