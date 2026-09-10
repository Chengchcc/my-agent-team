---
name: subagent-fanout
description: >
  Delegate work to subagents (task batch fan-out) and write/run
  workflow_run orchestration scripts for large-scale subagent tasks:
  audits, migrations, multi-source research, fix-until-pass loops.
user_invocable: true
---

# Subagent Fan-out

Two complementary surfaces: the `task` tool for delegating work to
subagents, and `workflow_run` for orchestration scripts.

## task — batch fan-out (preferred)

For independent items: `task({ context, tasks: [{ task, name?, agent?, outputSchema? }] })`.

- One subagent per item, bounded by the executor semaphore (max 64 items).
- `context` (required) is shared background prepended to every spawn.
- `agent` selects a role: `task` (full tools), `explore` (read-only),
  `plan` (read-only planning), or any `.oma/agents/<name>.md` definition.
- Long results spill to `.oma/workflow` with a `resultPath` — read them
  back instead of carrying them inline.
- Single background dispatch: `task({ agent, prompt, background: true })`
  returns a handle; poll it with `task_output`, stop with `task_stop`,
  list live handles with `task_list`. Follow up a finished handle with
  `task({ resume: <handle>, prompt })`.

## workflow_run — orchestration script

For loops/branches/intermediate state. The script is top-level-await JS
in a vm sandbox with NO fs/network — agents do the work:

- `agent(prompt, { schema?, label? })` — spawns one subagent, returns its result.
- `pipeline(items, fn)` — Promise.all over a mapper.
- Save with `workflow_run({ script, name })` to `.oma/workflow/<name>.js`;
  re-run later with `workflow_run({ name })` only.

## Rules

- Subagents inherit the workspace: write conflicts are YOUR sharding
  responsibility.
- Keep per-item prompts self-contained (subagents see no parent context).
- Prefer a `task` batch unless you need a loop or an intermediate value.
