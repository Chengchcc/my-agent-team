---
name: agent_fanout
description: >
  Delegate work to subagents (`task` batch fan-out) and write/run dynamic
  `orchestrate` JS scripts for multi-stage pipelines, fix-until-pass loops,
  and large map-reduce sweeps without polluting the main context.
roles: worker
user_invocable: true
---

# Subagent Fan-out & Dynamic Orchestration

Two complementary surfaces inside `oma` — distinct from the Product Backend's
declarative `*.workflow.json` DAGs (see `workflow_design` for scheduled/HITL
product workflows):

| Surface | Best for | Control flow |
|---|---|---|
| `task` | Independent parallel subtasks (1–64 items) | Single-stage batch |
| `orchestrate` | Multi-stage pipelines, retries/loops, filtering & map-reduce aggregation | JS code (top-level `await`) |

## `task` — batch fan-out (single stage)

For independent items: `task({ context, tasks: [{ task, name?, agent?, outputSchema? }] })`.

- One subagent per item; one batch carries at most 64 items. Execution
  concurrency is governed by the executor semaphore (`maxConcurrent = 8`,
  `maxTotal = 64` per session).
- `context` (required) is shared background prepended to every spawn.
- `agent` selects a role: `task` (full tools), `explore` (read-only),
  `plan` (read-only planning), or any `.oma/agents/<name>.md` definition.
- Long results spill to `.oma/workflow` with a `resultPath` — read them
  back instead of carrying them inline.
- Single background dispatch: `task({ agent, prompt, background: true })`
  returns a handle immediately. Drive background work via `hub`
  (`jobs`, `output`, `wait`, `steer`, `stop`), and follow up with
  `task({ resume: <handle>, prompt })`.

## `orchestrate` — dynamic JS orchestration script

Use `orchestrate` when intermediate results should stay in script memory or
when control flow depends on runtime outputs (loops, branches, dynamic fan-out).
Scripts execute as top-level-await JS inside an isolated subprocess with NO
direct filesystem writes or network access.

### Available Primitives

- **`agent(prompt, opts?)`** — spawns one subagent and resolves to
  `{ ok, label, text, output?, error?, artifacts?, usage?, handle? }`.
  - `opts`: `{ role?, model?, tools?, schema?, label?, timeoutMs? }`
  - `role`: `"task"` (default), `"explore"`, `"plan"`, or `.oma/agents/<name>.md`
  - `schema`: JSON Schema for structured `output` (enforced via `yield` tool)
  - `model`: optional `<provider>/<model>` override (e.g. fast model for triage)
  - `tools`: optional tool allowlist subset (cannot widen beyond role or run filter)
- **`parallel(items, fn, { concurrency? })`** (alias: `pipeline`) — maps
  `items` concurrently with optional concurrency limit.
- **`tool(name, input)`** — deterministic read-only workspace inspection
  directly from JS without spawning an LLM subagent. Allowed tools:
  `glob`, `grep`, `read`, `ls`, `tree`. Writes and shell execution must go
  through `agent()`.
- **`phase(name, fn)`** — marks a live progress stage in the TUI and returns
  `await fn()`.
- **`console.log(...)` / `log(...)`** — records progress messages returned in
  `logs` (never throws `ReferenceError`).
- **`args`** — object passed via `orchestrate({ ..., args })` or TUI
  `/orchestrate <name> --args '<json>'`.

### Persistence & Reuse

- Save reusable scripts with `orchestrate({ script, name })` → writes
  `.oma/orchestrations/<name>.js`.
- Re-run later with `orchestrate({ name, args? })` or in the TUI via
  `/orchestrate <name> --args '<json>'` (legacy alias `/workflow`).
- Default wall-clock timeout is 30 minutes (`timeoutMs` up to 60 minutes);
  aborting the run (`Esc`) cancels both the worker process and in-flight subagents.

### Example: Discover → Parallel Audit → Synthesize

```js
const files = await phase("discover", async () => {
  const res = await tool("glob", { pattern: "src/**/*.ts" });
  const lines = String(res.content ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("No files") && !line.endsWith(".test.ts"));
  return lines.slice(0, 20);
});

const findings = await phase("audit", () =>
  parallel(
    files,
    (file) =>
      agent(`Audit ${file} for error-handling bugs.`, {
        role: "explore",
        label: file,
        schema: {
          type: "object",
          properties: {
            issues: { type: "array", items: { type: "string" } },
          },
          required: ["issues"],
        },
      }),
    { concurrency: 4 },
  ),
);

return findings
  .filter((r) => r.ok && r.output?.issues?.length > 0)
  .map((r) => ({ file: r.label, issues: r.output.issues }));
```

## Rules

- Subagents inherit the workspace: write conflicts are YOUR sharding responsibility.
- Keep per-item prompts self-contained (subagents see no parent context).
- Use `tool("glob" | "grep" | "read", ...)` for deterministic discovery instead of burning an LLM call just to list files.
- Prefer `task` for simple 1-stage fan-out; use `orchestrate` for multi-stage pipelines, loops, or large map-reduce filtering.
