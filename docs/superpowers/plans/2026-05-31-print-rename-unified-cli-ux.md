# `print` Rename + Unified CLI UX — Consolidated Spec

> **Branch**: `feat/print-rename-and-unified-cli-ux`
> **Estimated LOC**: net +~700, ~25 files touched
> **Source**: 15-round grilled spec, decisions resolved inline
>
> Every design question has a settled answer. No TBDs, no placeholders.

---

## Architecture Decisions (resolved)

| # | Decision | Rationale |
|---|---|---|
| D1 | Daemon parser stays separate from CLI parser; `parseDaemonArgs` renamed | Different lifetimes, output types, blast radii (Q1) |
| D2 | Named `Errors.*` constructors for first-run pain; generic fallback for unknowns | Triage rule: user-recoverable + common → named; rest → generic + `--verbose` (Q2) |
| D3 | `prompts.fail()` + `runWithPromptGuard()` for clack safety | `clack.cancel('')` restores terminal; `main.ts` is sole error text source (Q3) |
| D4 | `-s` kept as alias, `--session` added as long form | Both accepted; ad-hoc `indexOf('-s')` replaced by `parseArgv` (Q4) |
| D5 | `--output-format` whitelist with hard error for unknown values | Silent data corruption > loud failure; whitelist narrows as formats land, no code deleted (Q5) |
| D6 | Two-pass parse: global permissive (unknown → positionals) + handler strict (unknown → error) | Avoids circular imports; isolates flag conflicts per command (Q6) |
| D7 | Handler gets `agentId` from `ctx.agentId`; `getSessionAgentId`/`getAgentArg` deleted | Single source of truth; no duplicated flag parsing (Q7) |
| D8 | RPC architecture split (ctx.rpc vs self-built transport) is intentional, out of scope | Long-connection paths need event subscriptions; ctx.rpc is request-response only (Q7) |
| D9 | Three-layer test: L1 unit (parser/errors), L2 handler unit (DI `runPrint`), L3 e2e (`bootE2E` + inmem) | Zero daemon dependency; zero flake from env state (Q8) |
| D10 | `cli-print.ts` split: `handler` → `runPrint` → `runPrintWithTransport` | DI at each boundary; `runPrintWithTransport` receives connected Transport, doesn't close it (Q9) |
| D11 | `CliManifest.needs` declares runtime capabilities; `buildRuntimeContext` initializes on demand | `agentStore` and `rpc` are mutually exclusive; no command needs both (Q10) |
| D12 | Hard rename `headless` → `print`, no deprecation shim | Pre-1.0, no semver promise; CHANGELOG documents breaking change (Q11) |
| D13 | stdin: `isTTY` sole signal; first-byte timeout 50ms (not total); 10MB cap | Distinguishes "pipe feeding data" from "pipe hung open"; no total-timeout truncation (Q12) |
| D14 | `--no-stdin` and `--stdin-timeout` are print-command-local flags (strict parse), not global | Only `print` reads stdin; global pollution would violate D11 (Q13) |
| D15 | `--help` built into `parseArgv` as reserved word; `main.ts` intercepts before `buildRuntimeContext` | Zero-cost help; handler never sees `--help`; flag mechanism (not throw) (Q14-Q15) |

---

## Phase 0 — Naming alignment + infrastructure

### S-0.1 Rename `headless` → `print`

| Op | Path |
|---|---|
| `git mv` | `src/cli/commands/cli-headless.ts` → `src/cli/commands/cli-print.ts` |
| Edit | `cli-print.ts`: rename export `cliHeadless` → `cliPrint`; `name: 'headless'` → `name: 'print'`; `description` → `'Run a single-turn agent non-interactively (stdin/stdout)'`; `usage` → `'my-agent print [flags] "<prompt>"'` |
| Edit | `src/cli/cli-registry.ts`: `cliHeadless` → `cliPrint` (import + array entry) |

### S-0.2 Purge `-p`/`--profile` residue

| File | Change |
|---|---|
| `src/cli/main.ts:23` | Delete ad-hoc filter `rest.filter(a => a !== '-p' && ...)` — replaced by Phase 1 permissive parse |
| `src/cli/cli-runtime.ts:70-74` | Delete `-p` fallback; keep only `--agent` (replaced by Phase 1) |
| `src/cli/commands/cli-daemon.ts:17-22` | Delete `--profile` branch + deprecation `console.warn` |
| `src/cli/commands/cli-session.ts:11-17` | Delete `getSessionAgentId` function entirely (D7) |
| `src/cli/commands/cli-agent.ts:93-95` | Delete `--profile` alias |
| `src/cli/commands/cli-print.ts` | Delete `-p`-aware filter; switch session flag from ad-hoc to `parseArgv` with `FLAG_SESSION` |
| `src/interface/daemon/parse-daemon-args.ts` | Delete `--profile` line + `MY_AGENT_PROFILE` env; remove from ESLint allowlist |
| `src/cli/cli-runtime.ts:28,38` | Fix hint text `--agent-id=<id>` → `--agent <id>` |

### S-0.3 `parseArgs` → `parseDaemonArgs`

| File | Change |
|---|---|
| `src/interface/daemon/parse-daemon-args.ts` | Rename export `parseArgs` → `parseDaemonArgs` |
| `bin/my-agent-daemon.ts:4,8` | Update import + call site |

### S-0.4 `CliManifest.needs` (D11)

Extend `CliManifest` in `src/cli/cli-types.ts`:

```ts
export interface CliManifest {
  readonly name: string
  readonly description: string
  readonly usage: string
  readonly handler: (argv: string[], ctx: CliRuntimeContext) => Promise<void>
  /** Declares which runtime capabilities this command needs. Defaults to []. */
  readonly needs?: ReadonlyArray<'agentStore' | 'rpc'>
}
```

Assign `needs` to all 11 commands:

| Commands | `needs` |
|---|---|
| `setup`, `agent`, `agent-lark` | `['agentStore']` |
| `daemon`, `session`, `print` | `[]` (paths + agentId only) |
| `memory`, `trace`, `mcp`, `evolution`, `skills`, `logs` | `['rpc']` |

### S-0.5 `buildRuntimeContext` per-needs (D11)

Change signature from `(argv: string[])` to `(opts: { agentId: string; needs: ReadonlyArray<'agentStore' | 'rpc'> })`.

`agentStore` init only when `needs.includes('agentStore')`.
`rpc` lazy holder only when `needs.includes('rpc')`.

`CliRuntimeContext.rpc` becomes optional (`rpc?`). Add `requireRpc(ctx)` helper for handlers.

### S-0.6 Add `src/cli/exit-codes.ts`

```ts
export const EXIT = {
  OK: 0,
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,
} as const
```

---

## Phase 1 — Unified argv parser

### S-1.1 New file `src/cli/args/parse.ts` (~140 LOC)

```ts
export type ParseMode = 'permissive' | 'strict'

export interface FlagSpec {
  name: string
  alias?: string
  type: 'string' | 'boolean'
  default?: string | boolean
  required?: boolean
  description: string
}

export interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
  raw: string[]
}

export class UnknownFlagError extends Error {
  constructor(
    public readonly flag: string,
    public readonly supported: readonly string[],
  ) { super(`Unknown flag: ${flag}`) }
}

export class MissingFlagError extends Error {
  constructor(
    public readonly flag: string,
    public readonly command: string,
  ) { super(`Missing required flag: ${flag}`) }
}

export class HelpRequestedError extends Error {
  constructor(public readonly scope: 'global' | string) { super('help') }
}

export function parseArgv(
  argv: string[],
  specs: FlagSpec[],
  mode: ParseMode = 'strict',
): ParsedArgs
```

**Rules:**
- `--name value`, `--name=value`, `-a value` all supported
- `--` ends flag parsing; remaining → `positional`
- Boolean flags: `--flag` = true, `--no-flag` = false
- `--help` / `-h` are built-in reserved words → `flags.help = true` (not in any FlagSpec)
- **permissive**: unknown long flag + its value → both preserved in `positional`
- **strict**: unknown long flag → throw `UnknownFlagError`
- Known boolean flag doesn't consume next token
- Known string flag without value → throw `MissingFlagError`

**permissive behavior table:**

| Input | permissive result |
|---|---|
| `--unknown value` | Both tokens go to `positionals` |
| `--unknown=value` | Single token goes to `positionals` |
| `-x value` (unknown short) | Both tokens go to `positionals` |
| `--verbose value` (known boolean) | `verbose=true` in flags, `value` in positionals |
| `--agent` (known string, no value) | Throw `MissingFlagError` |
| `--` | Everything after goes to positionals |

### S-1.2 Shared flag specs `src/cli/args/common-flags.ts` (~30 LOC)

```ts
export const FLAG_AGENT: FlagSpec       = { name: 'agent',   alias: 'a', type: 'string',  default: 'default', description: 'Agent ID' }
export const FLAG_SESSION: FlagSpec     = { name: 'session', alias: 's', type: 'string',  description: 'Session ID (default: main)' }
export const FLAG_VERBOSE: FlagSpec     = { name: 'verbose', alias: 'v', type: 'boolean', default: false, description: 'Show debug traces on error' }
export const FLAG_OUTPUT_FORMAT: FlagSpec = { name: 'output-format', type: 'string', default: 'text', description: 'text | json | stream-json' }
```

### S-1.3 `main.ts` dispatch with permissive parse

```ts
const GLOBAL_FLAGS: FlagSpec[] = [FLAG_AGENT, FLAG_VERBOSE]

const parsed = parseArgv(argv, GLOBAL_FLAGS, { mode: 'permissive' })
const [cmdName, ...rest] = parsed.positionals

// --help intercept (D15) — before buildRuntimeContext, zero I/O
if (parsed.flags.help) {
  const cmd = cmdName ? findCommand(cmdName) : null
  if (cmd) {
    ctx.out(renderCommandHelp(cmd))
  } else {
    ctx.out(renderGlobalHelp())
  }
  return
}

const cmd = findCommand(cmdName)
if (!cmd) throw Errors.unknownCommand(cmdName)

const ctx = await buildRuntimeContext({
  agentId: String(parsed.flags.agent ?? 'default'),
  needs: cmd.needs ?? [],
})

await cmd.handler(rest, ctx)
```

### S-1.4 Handler strict parse pattern

Every handler: `parseArgv(argv, [...local flags], { mode: 'strict' })`. Unknown flags → `UnknownFlagError` caught by `main.ts`.

### S-1.5 Wire into all subcommands

Replace all ad-hoc `indexOf` blocks in: `cli-runtime.ts`, `cli-daemon.ts`, `cli-session.ts`, `cli-print.ts`, `cli-agent.ts`, `cli-agent-lark.ts`.

Delete `getAgentArg` (cli-daemon.ts) and `getSessionAgentId` (cli-session.ts) — handlers get `agentId` from `ctx.agentId` (D7).

---

## Phase 2 — Unified error UX

### S-2.1 New file `src/cli/errors/cli-error.ts` (~120 LOC)

```ts
export class CliError extends Error {
  readonly code: string
  readonly hint?: string
  readonly details?: unknown
  readonly exitCode: number

  constructor(opts: {
    code: string
    message: string
    hint?: string
    details?: unknown
    exitCode?: number
    cause?: unknown
  })
}

export const Errors = {
  daemonNotRunning(agentId: string, socketPath: string): CliError,
  daemonConnectFailed(socketPath: string, cause: unknown): CliError,
  agentNotFound(agentId: string): CliError,
  sessionNotFound(sessionId: string): CliError,
  unknownCommand(name: string): CliError,
  unknownFlag(flag: string, supported: readonly string[]): CliError,
  missingFlag(flag: string, command: string): CliError,
  missingPrompt(): CliError,
  rpcFailed(method: string, cause: unknown): CliError,
  turnFailed(reason: string): CliError,
  unsupportedFormat(got: string, supported: readonly string[]): CliError,
  stdinTooLarge(bytes: number, cap: number): CliError,
  fsInitFailed(path: string, cause: unknown): CliError,
  registryInitFailed(dbPath: string, cause: unknown): CliError,
  flagMissingValue(flag: string): CliError,
}
```

### S-2.2 New file `src/cli/errors/render.ts` (~80 LOC)

```ts
interface RenderOpts { verbose: boolean }

export function renderCliError(err: unknown, opts: RenderOpts): { stderr: string; exitCode: number }
```

**Friendly mode (default):**
```
✖  Daemon not running for agent "default".

   ›  start it first:  my-agent daemon start --agent default
   ›  or pick a different agent:  my-agent --agent <id> ...
```

**Verbose mode (`--verbose`):**
```
✖  [DAEMON_NOT_RUNNING] Daemon not running for agent "default".

   socketPath:  /home/mira/.my-agent/agents/default/daemon.sock
   exists:      false

   Hint: start it first:  my-agent daemon start --agent default

   Stack:
     at ...
```

Generic fallback for non-`CliError`: friendly message + "run with --verbose for details". Verbose mode adds stack.

### S-2.3 `main.ts` top-level catch

```ts
try {
  // ... dispatch ...
} catch (err) {
  const { stderr, exitCode } = renderCliError(err, { verbose })
  process.stderr.write(stderr)
  process.exit(exitCode)
} finally {
  if (ctx) await disposeRuntimeContext(ctx)
}
```

### S-2.4 Fix `bin/my-agent-cli.ts`

Catch also uses `renderCliError` (safety net for errors escaping `main.ts` finally).

### S-2.5 Migrate all error sites

Replace all `console.error` + `process.exit` and bare `throw new Error(...)` with `CliError` constructors across: `cli-runtime.ts`, `cli-print.ts`, `cli-session.ts`, `cli-daemon.ts`, `cli-agent.ts`, `cli-agent-lark.ts`, `create-agent-flow.ts`, `identity-flow.ts`, `interface/daemon/main.ts`.

### S-2.6 Interactive flow error handling (D3)

Add `prompts.fail(message, hint?): never` to `Prompts` interface. Calls `clack.cancel()` then exits 2.

Add `runWithPromptGuard(prompts, fn)` which catches throws inside clack scope, calls `clack.cancel('')` to restore terminal, re-throws for `main.ts` rendering.

Move `identity-flow.ts:53` provider check to caller (`create-agent-flow.ts`) — caller has `prompts`.

### S-2.7 ESLint guard for `process.exit` + `console.error`

```js
files: ['src/cli/**/*.ts', 'src/interface/**/*.ts'],
rules: {
  'no-console': ['error', { allow: ['log'] }],
  'no-restricted-syntax': ['error', {
    selector: 'CallExpression[callee.object.name="process"][callee.property.name="exit"]',
    message: 'Use CliError + throw; let main.ts handle exit.'
  }]
}
```

Allowed sites: `main.ts` catch, `prompt-runner.ts` cancel paths (7x `process.exit(0)`), `cli-daemon.ts` log subprocess passthrough.

---

## Phase 3 — `print` command upgrade

### S-3.1 Three-layer split (D10)

```
handler(argv, ctx)                          → ctx → opts assembly
runPrint(opts: PrintOpts)                   → socketPath → UnixSocketTransport → connect → delegate
runPrintWithTransport(opts)                 → transport (already connected) → RPC → event stream → PrintResult
```

**Types:**

```ts
interface PrintOpts {
  socketPath: string
  sessionId: string
  prompt: string
  onAssistantText?: (chunk: string) => void
}

interface PrintWithTransportOpts {
  transport: Transport
  sessionId: string
  prompt: string
  onAssistantText?: (chunk: string) => void
}

interface PrintResult {
  text: string
  turnId: string
}
```

**Contracts:**
- `runPrintWithTransport` does NOT close transport; caller owns lifecycle
- `runPrint` creates transport, connects, delegates, finally closes
- `handler` delegates to `runPrint`, doesn't touch transport
- `onAssistantText` DI: defaults to `s => process.stdout.write(s)`

### S-3.2 State machine in `runPrintWithTransport`

- Register `onEvent` → get unsubscribe function
- `try { await done } finally { unsubscribe() }`
- `turn.failed` → reject `Errors.turnFailed(reason)`
- `session.attach` / `input.send` RPC error → reject `Errors.rpcFailed(method, cause)`
- Success → resolve `PrintResult`

### S-3.3 Stdin support (D13)

New file `src/cli/io/read-stdin.ts` (~50 LOC):

- `isTTY` → return `''` (sole signal, no buffer probing)
- First-byte timeout 50ms (not total timeout)
- After first byte: read to EOF, no timeout, 10MB cap
- Exceed 10MB → throw `Errors.stdinTooLarge`
- `tail -f` hang documented in `usage` string; user responsibility

### S-3.4 Print command flag schema

```ts
const PRINT_FLAGS: FlagSpec[] = [
  FLAG_SESSION,
  FLAG_OUTPUT_FORMAT,
  { name: 'no-stdin', type: 'boolean', default: false, description: 'Do not read stdin' },
  { name: 'stdin-timeout', type: 'string', default: '50', description: 'First-byte timeout in ms' },
]
```

Flags are **command-local** (strict parse), not global (D14).

### S-3.5 Output format whitelist (D5)

```ts
const SUPPORTED_FORMATS = ['text'] as const

const format = String(parsed.flags['output-format'] ?? 'text')
if (!SUPPORTED_FORMATS.includes(format as typeof SUPPORTED_FORMATS[number])) {
  throw Errors.unsupportedFormat(format, SUPPORTED_FORMATS)
}
```

Validate before any I/O. Adding `json` later = one-line diff: `['text', 'json']`.

### S-3.6 Exit code correctness

`runPrintWithTransport` rejects with `CliError` on `turn.failed` → `main.ts` catch renders → exit 1. No more `process.exit(0)` on failure. Natural exit 0 on success (finally dispose, then return).

### S-3.7 Prompt assembly

```ts
const stdinText = parsed.flags['no-stdin'] || Number(parsed.flags['stdin-timeout']) === 0
  ? ''
  : await readStdinIfPiped({ firstByteTimeoutMs: Number(parsed.flags['stdin-timeout']) })
const promptArg = parsed.positional.join(' ')
const prompt = [stdinText, promptArg].filter(Boolean).join('\n\n').trim()
if (!prompt) throw Errors.missingPrompt()
```

---

## Phase 4 — Tests

### T-1 `tests/cli/args/parse.test.ts` (new, ~140 LOC)

- Positional only
- `--agent foo`, `--agent=foo`, `-a foo`
- Boolean `--verbose` / `--no-verbose`
- `--` terminator
- Unknown flag → strict throws, permissive preserves
- Missing required → `MissingFlagError`
- Value-equals-flag-name regression (G16)
- `--help` sets `flags.help = true`
- Permissive mode: all 7 boundary cases from behavior table

### T-2 `tests/cli/errors/render.test.ts` (new, ~100 LOC)

- Friendly: no stack, has hint, no `[CODE]`
- Verbose: stack present, cause chain, `[CODE]` present
- Unknown error wrapped with "run with --verbose"
- Each `Errors.*` constructor produces expected `code` + `exitCode`

### T-3 `tests/cli/cli-print.test.ts` (new, ~120 LOC)

- `runPrint(socketPath=nonexistent)` → `E_DAEMON_NOT_RUNNING`
- `runPrint(socketPath=nonexistent, verbose)` → includes stack
- `runPrintWithTransport(transport=inmem, turn=fail)` → `E_TURN_FAILED`, exit 1
- `runPrintWithTransport(transport=inmem, turn=ok)` → `PrintResult.text`

### T-4 `tests/cli/read-stdin.test.ts` (new, ~60 LOC)

- isTTY → immediate `''`
- Pipe + immediate data → full read
- Pipe + 50ms no data → `''`, no hang
- Pipe + data > 10MB → `E_STDIN_TOO_LARGE`

### T-5 `tests/cli/manifest-needs.test.ts` (new, ~30 LOC)

Snapshot test: each command's `needs` matches expected array.

### T-6 `tests/e2e/print-mode.spec.ts` (new, ~150 LOC)

Uses `bootE2E` + inmem transport + `runPrintWithTransport`:
- Successful turn returns text
- `turn.failed` → `CliError`
- Piped stdin integration

### T-7 `tests/cli/_setup.ts` (new, ~15 LOC)

```ts
beforeEach(() => {
  delete process.env.MY_AGENT_HOME
  delete process.env.MY_AGENT_AGENTS_ROOT
  delete process.env.MY_AGENT_PROFILE
  delete process.env.MY_AGENT_PROFILE_ROOT
  delete process.env.MY_AGENT_VERBOSE
})
```

### T-8 Rename existing test files

Bulk replace `headless` → `print`, `cliHeadless` → `cliPrint` across `tests/`.

---

## Phase 5 — Docs & help text

### S-5.1 `main.ts` help rendering

`renderGlobalHelp()`: command list with descriptions, global flags, usage examples.
`renderCommandHelp(cmd)`: command-specific usage + flag list from `CliManifest`.

### S-5.2 `README.md` / `README.en.md`

Replace `my-agent headless` → `my-agent print`.

### S-5.3 CHANGELOG

New file `docs/changes/2026-05-31-print-rename.md`:
- `headless` removed → use `print`
- `-p`/`--profile` removed → use `-a`/`--agent`
- Errors now rendered friendly by default; pass `--verbose` for stack traces

---

## Phase 6 — knip / lint guard

- New files referenced from `main.ts` + subcommands → knip-clean
- ESLint rule for `process.exit` + `console.error` (S-2.7)
- `eslint-disable-next-line` at 3 legitimate sites

---

## Execution Order (6 commits)

1. `chore(cli): rename headless → print, add CliManifest.needs, per-needs buildRuntimeContext, drop -p/--profile residue` (Phase 0)
2. `feat(cli): unified argv parser + shared flag schema` (Phase 1)
3. `feat(cli): typed CliError + friendly/verbose renderer` (Phase 2.1-2.3)
4. `refactor(cli): migrate all error sites to CliError` (Phase 2.4-2.6)
5. `feat(cli/print): stdin support, exit-code fix, output-format whitelist, three-layer split` (Phase 3)
6. `test(cli): args parser, error render, print regression suite, manifest-needs` (Phase 4) + docs (Phase 5) + lint guard (Phase 6)

Each commit passes `bun test` + `bun run check:guard` + `bun run lint` independently.

---

## Out of Scope

- `--output-format json/stream-json` implementation (next spec)
- `--continue`/`--resume`/`--max-turns`/`--allowedTools`/`--system-prompt`/`--bare` (Claude Code parity, separate spec)
- Unified RPC transport with event subscriptions (separate spec)
- Ephemeral daemon (G1)
- Env-var fallback inside `parseArgv` (daemon env vars stay in `parseDaemonArgs`)
- Global clack-state tracker
