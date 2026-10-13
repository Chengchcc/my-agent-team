---
name: agentic-workflow-dsl
description: >
  Generate or validate an Agentic Workflow DSL (*.workflow.json): the node graph
  (start/end/agent/script/human), JSONLogic edge conditions, meta, and
  input/output schemas. Not for oma subagent fan-out orchestration (see
  subagent-fanout).
user_invocable: true
---

# Agentic Workflow DSL

## Purpose

Two jobs: **generate** a legal DSL, and **validate** a DSL's legality. A legal
DSL is one `parseWorkflow` (packages/workflow) accepts. This skill keeps no
second copy of the rules: in the product, writing a definition through the
workflow MCP `workflow_write` **is** the check (it calls `parseWorkflow`). In
standalone oma there is no such tool, so check the file against the checklist
below by hand.

## The definition file (product backend runs)

In the product the definition lives at `<backend-dataDir>/workflows/<id>.workflow.json`
— **outside the agent workspace**, so `read`/`write`/`edit`/`glob`/`grep` refuse
it with `path escapes workspace`, whatever path you construct. Reach it through
the injected workflow MCP tools instead (oma exposes them as
`mcp__workflow__workflow_read` / `mcp__workflow__workflow_write`):

- `workflow_read { workflowId }` → the raw JSON.
- `workflow_write { workflowId, definition }` → validated by `parseWorkflow`,
  then surfaced in the workflow editor as an **unsaved** change; the user
  applies it with Ctrl/Cmd+S. A successful call means "proposed", not "saved".

The `workflowId` is the filename stem (`nighttime-report`), never a path.
Standalone oma (no backend) injects no such tools — edit the file directly there.

## Shape

```jsonc
{
  "version": 1,
  "id": "oncall-triage",
  "meta": { "name": "…", "description": "…", "tags": ["…"], "status": "draft|active|archived", "owner": "…", "updatedBy": "…" },
  "input": [
    { "key": "issueUrl", "type": "string" },
    { "key": "report", "type": "artifact" }
  ],
  "triggers": [ { "type": "cron", "cron": "0 2 * * *", "enabled": true } ],
  "nodes": [ /* see Node types */ ],
  "edges": [ { "from": "a", "to": "b", "when": { "==": [ { "var": "a.output.x" }, "high" ] } } ]
}
```

**Triggers** (optional): `triggers` is an array. Each item is
`{ "type": "cron", "cron": "<5-field expr UTC>", "enabled": true }`. API trigger
is implicit — any workflow can be invoked via `POST /api/workflow-executions`;
cron triggers only add scheduling. `"enabled": false` keeps a trigger
registered but paused.

## Node types

| type | required | notes |
|---|---|---|
| start | — | entry; output = trigger vars; exactly one |
| end | `status` | success/failure/custom; multi-exit allowed |
| agent | `agentId` OR (`model`+`prompt`) | may return `nextNode` to override edges |
| script | `code` | Bun TS default export; optional `timeoutMs` |
| human | optional `question`/`form` | ask-user; answers = output; optional `timeoutMs` fails the node if nobody answers |

Optional per-node `inputSchema`/`outputSchema` (JSON Schema subset), `retry`,
and `input`/`output` hints — both are arrays of `{ "key": …, "type": … }` with
type one of `string | number | boolean | artifact` (same shape as the
workflow-level `input`).

The engine reads only these schema keys — `type/properties/required/
additionalProperties/items/enum/minimum/maximum/minLength/maxLength/minItems/
maxItems` (`packages/workflow/src/schema.ts`). `parseWorkflow` does not police
the key list; an unknown key is kept and simply never checked.

**artifact type**: a field whose value is an `artifacts://<folder>/<file>`
URL. Input artifact fields are checked to exist before the node runs; output
artifact fields must exist after it runs (the node must upload them via the
`artifact_upload` MCP tool). Use them to hand files between agents.

## Edges

- `{ from, to, when?, kind?, budget? }`; `when` is JSONLogic **subset**:
  `var`/`==`/`!=`/`>`/`>=`/`<`/`<=`/`in`/`and`/`or`/`not`/`if`/`!!`; paths are
  `nodeId.output.field`.
- Multi-true edges = parallel fan-out — keep branch conditions mutually
  exclusive unless parallel is intended.
- `nextNode` override must target a node an existing edge already reaches.

### Rework: send work back, as a new attempt

`kind: "rework"` means "the source judged the target's work unusable and sends
it back". The target — and everything downstream of it — runs again as a new
attempt, told which round it is and why. The graph stays acyclic: a rework edge
points UPSTREAM (the target must be an ancestor of the source) and is never part
of the forward walk, so it neither routes nor joins.

A rework edge MUST declare its budget; there is no unbudgeted rework:

```json
{
  "from": "review", "to": "build", "kind": "rework",
  "when": { "==": [{ "var": "review.output.verdict" }, "redo"] },
  "budget": { "maxAttempts": 3, "onExhausted": "human" }
}
```

- `when` reads the SOURCE's output (a rework edge with no `when` always fires).
- `budget.maxAttempts` counts the TARGET's attempts in one execution, the first
  run included: `1` means the target can never be sent back.
- `budget.onExhausted`: `"fail"` ends the execution naming the rounds and the
  last verdict; `"human"` parks a gate whose decision is `{ "decision":
  "grant" }` (one more attempt) or `{ "decision": "reject" }` (end it).
- The next attempt receives `attempt` and `rework: { from, reason }` as input;
  `reason` is the source's verdict — its `reason`/`feedback`/`error`/`message`/
  `summary` field, else its whole output.
- A retry does NOT see the stale outputs it replaces.

Author the loop as: produce → judge → rework edge with a budget. Do not reach
for cycles (rejected outright) or for one node retrying itself (`retry` is only
for transient failure of the same attempt).

## Validate — what `parseWorkflow` refuses

1. `version` must be `1`; `id` non-empty.
2. Exactly one `start`; node ids `/^[a-zA-Z0-9_-]+$/`, unique, non-empty.
3. `nodes` non-empty; each `type` in start|end|agent|script|human; `nodes` and
   `edges` must be arrays, every node and edge an object.
4. Per-type required: end `status`; agent `agentId` OR (`model` AND `prompt`);
   script `code`. A human `form` field's `type` must be one of
   `string|textarea|number|enum|date|boolean`.
5. `edges` reference existing node ids (both ends).
6. Every non-start node is reachable from start — a dangling node is a parse
   error, not a warning.
7. Graph acyclic (`parseWorkflow` ends in `topoSort`, which throws on a cycle;
   rework edges are excluded from that walk, so a rework is not a cycle).
7b. Rework edges: `kind` is `"forward"` or `"rework"`; a rework edge needs a
   `budget` whose `maxAttempts` is a positive integer and `onExhausted` is
   `"fail"` or `"human"`; its target must be upstream of its source; a `budget`
   on a forward edge is refused.
8. `when` uses only the JSONLogic subset above; a `nodeId.output.field` var path
   must name an existing node, and — for a node that declares output fields
   (human gates: form field names; script/agent: their `output` hint keys) — a
   field in that list. Nodes declaring none are not checked.
9. `input`/`output` (workflow and per-node) are arrays of
   `{ "key": non-empty string, "type": "string"|"number"|"boolean"|"artifact" }`.
   Object maps are NOT accepted.
10. `triggers` is an array of `{ type: "cron", cron: non-empty string,
    enabled?: boolean }`.

Silently accepted (veto them yourself when authoring): duplicate `key`s inside
an `input`/`output` array; a malformed `retry` (dropped); a non-object
`inputSchema`/`outputSchema` (dropped); `meta.status`/`meta.tags` values outside
draft|active|archived and an array of strings (dropped, not refused).

Report violations as `$.nodes[2].status missing` style paths; when asked to
fix, return the corrected full DSL.

## Output contract

When asked to author/edit, respond with **the entire updated DSL as a single
JSON object** (no markdown fence, no prose). The caller parses it, runs
`parseWorkflow` on it, and applies it as a patch.
