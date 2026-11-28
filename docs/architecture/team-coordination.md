---
title: Team Coordination
description: PA + Worker hard boundaries, Product Tools MCP (32+3+2 tools) & run tokens, intent-faceted room dispatch, capability pool recall, duplex loop, risk/request ownership, delivery gate, and proposals
tags: [backend, coordination, product-tools, proposals]
---

# Team Coordination

CrewDesk structures multi-agent work around a **hard code-enforced split** between a human-facing **PA (Front Desk)** and specialist **Workers** (ADRs 0047, 0049, 0051, 0054, 0056–0060, 0070, 0072, 0074–0075, 0080–0081). Coordination happens exclusively through backend-owned **Product Tools MCP** servers authenticated by ephemeral per-Run tokens.

## Authoritative files

- `apps/backend/src/features/agent/front-desk-tools.ts` — `FRONT_DESK_DISABLED_TOOLS` (14 stripped tools)
- `apps/backend/src/features/agent/prompt-front-desk.ts` — `FRONT_DESK_DISCIPLINE` (3 exits, routing & attention rules)
- `apps/backend/src/features/product-tools/manifest.ts` — 32 tool schemas & frozen Run manifest
- `apps/backend/src/features/product-tools/dispatch.ts` — MCP-over-ACP & SSE dispatcher
- `apps/backend/src/features/product-tools/mcp.ts` — Loopback SSE MCP server
- `apps/backend/src/features/product-tools/service.ts` — Product tool implementations & idempotency
- `apps/backend/src/features/product-tools/run-token-registry.ts` — Per-run SHA-256 bearer registry
- `apps/backend/src/features/product-tools/intent.ts` — Dispatch facets (`verb`/`deliverable`/`objectKind`/`reversibility`) & slot checks
- `apps/backend/src/features/product-tools/pool.ts` — Capability-weighted worker selection (`recallWorkers`)
- `apps/backend/src/features/agent-run/notify-dispatcher.ts` — Duplex worker-to-dispatcher notifications (`MAX_WAKE_DEPTH = 3`)
- `apps/backend/src/features/agent-run/request-owner.ts` — `requestOwnerOf()` (`agent:<dispatcher>` vs `user`)
- `apps/backend/src/features/agent-run/answer-guard.ts` — `beyondFrozenScope()` & `answerRefusal()`
- `apps/backend/src/features/agent-run/delivery-gate.ts` — Second-member verification gate (`producedByEvent`, `deliveryNoteOf`)
- `apps/backend/src/features/proposal/service.ts` & `apps/backend/src/features/proposal/apply.ts` — Proposal persistence & adoption
- `apps/backend/src/features/agent/agent-config-mcp.ts` — `agent_read`, `agent_write`, `agent_create` MCP server
- `apps/backend/src/features/workflow/mcp.ts` — `workflow_read`, `workflow_write` MCP server

## Front Desk vs Worker Boundaries

- **Front Desk (`role !== "worker"`):**
  - `FRONT_DESK_DISABLED_TOOLS` strips **14 tools** via `OMA_DISABLED_TOOLS`: `bash`, `eval`, `write`, `edit`, `read`, `ls`, `grep`, `glob`, `tree`, `web_search`, `web_fetch`, `browser`, `read_image`, `task`.
  - `FRONT_DESK_DISCIPLINE` is prepended before `SOUL.md` for every non-worker agent, enforcing 3 exits (`ANSWER` / `ASK` / `DISPATCH`), OA-style escalation via `ask_question`, second-member review before delivery, and `todo_write` planning.
  - Receives only `roles: front` builtin skills (`member_manage`, `project_manage`, `requirement_memory`, `team_dispatch`, `wiki_manage`, `reminder_manage`, plus shared `workflow_design`, `skills_about`).
- **Worker (`role === "worker"`):**
  - Keeps full execution/code tools; runs in child conversations (`parent_conversation_id`) and requirement git worktrees.
  - Cannot bind Lark (`agentConfigSchema` rejects `role === "worker"` + `lark.enabled === true`).
  - Human room messages targeting a worker reroute to the front desk unless `directToWorker: true` (ADR 0049).

## Product MCP Servers & Per-Run Token Auth

Three loopback MCP servers expose product capabilities to child harnesses:

| Server | Transport & Auth | Tools |
|---|---|---|
| `product-tools` | Loopback SSE (`127.0.0.1`) + in-process MCP-over-ACP (`AcpMcpProvider`). **Mandatory** `Bearer` token from `RunTokenRegistry`. | **32 tools:** `history_{recent,search,around,retain}` (4), `artifact_{upload,download}` (2), `todo_write` (1), `remind_me` / `reminder_{list,cancel}` (3), `wiki_{read,query,create,patch,lint,source_add}` (6), `project_{list,detail,attach,push,propose}` (5), `requirement_{track,query}` (2), `team_list`, `dispatch`, `steer_worker`, `cancel_worker`, `report`, `handback`, `answer_worker_request`, `ask_question`, `remember` (9). |
| `agent-config` | Loopback SSE (`127.0.0.1`, Host check `403` off-loopback, optional `RunTokenRegistry` auth). | **3 tools:** `agent_read`, `agent_write`, `agent_create` (rate-limited `5 / 10 min`). Never writes `agent.yml` directly; emits `agent_config` proposals. Forbids `permissionMode: "yolo"` and write/command policy fields. |
| `workflow` | Loopback SSE (`127.0.0.1`, Host check, optional bearer auth). | **2 tools:** `workflow_read`, `workflow_write` (validates via `parseWorkflow()`, emits `workflow_definition` proposals; never writes disk). |

**Identity & token invariants (ADR 0036):**
- `createRunTokenRegistry({ capacity: 10_000 })` mints 32-byte `base64url` tokens, stores only `sha256(token) → { runId, agentId }`, allows one live token per `runId`, and revokes in `dispatch`'s `finally` block.
- Authorization scope comes **strictly from the verified bearer token + DB `agent_run` row**; model-supplied `args.identity` is ignored for auth, `_meta.identity.runId` mismatches reject, the Run must be `running`, and the tool must exist in `agent_run.product_tools`.
- Mutating calls record `(run_id, call_id, input_hash)` in `product_tool_call` for idempotent replay.
- `PRODUCT_CONSENTED_MCP_TOOLS` (`workspace-bridge.ts`) pre-consents safe product tools inside `oma`, intentionally **excluding** `artifact_upload`, `remind_me`, `project_push`, `project_propose`, and `project_attach` so those stay permission-gated.

## Run Authorization Basis

Every Run carries a frozen `agent_run.authorization` string (preserved across `branch_input_queue` promotions; never accepted from HTTP callers):

| Value | Producer | Key Effects |
|---|---|---|
| `"user"` | Human message via Web/Lark HTTP | Required to authorize `remember` and irreversible `operate` dispatches. |
| `"dispatch:<fromAgentId>"` | `dispatch` / `steer_worker` | Sets `parent_run_id`; unlocks `report` and `handback`; routes non-irreversible worker questions to front desk. |
| `"handback:<fromAgentId>"` | `handback` | Wakes parent dispatcher with worker's decline reason. |
| `"result:<workerAgentId>"` | `notify-dispatcher.ts` | Delivers worker completion/attention notice; deliberately barred from calling `report` (prevents ping-pong). |
| `"system"` | Reminders & Workflow agent nodes | Automated execution; cannot authorize `remember` or irreversible dispatches. |

## Intent-Faceted Dispatch & Capability Pool Selection

Calling `dispatch` runs five strict checks before opening/reusing a child conversation (`parent_conversation_id`):

1. **Facet & pair validation (`intent.ts`):**
   - `verb`: `fix | build | review | investigate | write | operate | answer`
   - `deliverable`: `answer | change | report | state-change`
   - `objectKind`: `code | doc | service | data | other`
   - `reversibility`: `reversible | irreversible` (**defaults to `"irreversible"`** if omitted)
   - Legal `(verb, deliverable)` pairs: `fix → change|report`, `build → change`, `review|investigate|write → report`, `operate → state-change`, `answer → answer`.
2. **Required slot check:** `fix` requires `[repro, expected, scope, acceptance]`; `build` requires `[goal, scope, acceptance, constraints]`; `review` requires `[target, criteria]`; `operate` requires `[environment, action, rollback]`; `investigate`/`write`/`answer` require none. Missing slots fail once listing **all** gaps plus any `slotEvidence()` from turn recall.
3. **Irreversibility gate (ADR 0080):** `verb === "operate" && reversibility === "irreversible"` rejects unless `run.authorization === "user"`. When allowed, stamps `agent_run.risk = { irreversible: true }` on the worker's Run.
4. **Worker selection (`pool.ts` → `recallWorkers`):** if `agent` is omitted, filters enabled `role === "worker"` cards and scores `name + description + skills` with weights `verb: 4, capability: 3, objectKind: 2, term: 1 (max 2)`. Tie-breaks deterministically by `activeRuns ASC → lastRunAt ASC → id ASC` (idle never overrides capability). If the room is bound to a `project`, rejects workers not attached to that project.
5. **Brief framing & requirement link:** attaches non-`personal/` Wiki recall hits (`wiki:<path>`) and frames structured XML tags (`<dispatch>`, `<task>`, `<slots>`, `<references>`, `<front_findings>`, `<meta>`, `<workspace>`, `<delivery>`, `<original_request>`), linking the worker Run to a `requirement`.

## Duplex Execution Loop & Worker Notifications (ADR 0059)

- **`steer_worker`:** injects steering into a currently running worker; fails if idle (never silently queues).
- **`cancel_worker`:** aborts a running worker with a reason and notifies the dispatcher.
- **`report`:** permitted only on `dispatch:*` / `handback:*` runs. `purpose: "progress"` writes a ledger note without waking the dispatcher; `"attention"` and `"answer"` wake the dispatcher via `notify-dispatcher.ts`. Carries optional `verification: "not_configured" | "not_run" | "passed" | "failed"`.
- **`handback`:** permitted only on `dispatch:*` / `handback:*` runs; returns an out-of-lane task to the parent dispatcher with `authorization: "handback:<workerId>"`.
- **Dispatcher wakeup (`notify-dispatcher.ts`):** walks `parent_run_id` up to 10 hops with `MAX_WAKE_DEPTH = 3`. Below depth 3, attempts live steer into the parent's active Run (falling back to queued `postMessage`) and stamps `agent_run.result_notified_at`; at `depth >= 3`, posts to front desk/ledger to prevent runaway chains. Unnotified terminal runs are re-delivered on boot `recover()`.

## Request Ownership, Risk Escalation & Delivery Gate

- **Request routing (`request-owner.ts`, `answer-guard.ts`, ADR 0075/0080):**
  - When a worker raises an `ask_question` or approval, `createPendingAction` evaluates `run.risk.irreversible` and `beyondFrozenScope(payload, { toolPolicy })` (checks `denyCommands` and `allow` write prefixes).
  - If **irreversible** OR **beyond frozen scope**, `owner` is forced to `"user"` (human approval required).
  - Otherwise, if the dispatcher is a front-desk agent (`role !== "worker"`), `owner = "agent:<dispatcher>"` so the PA inspects first.
  - `answer_worker_request` requires non-empty `evidence[]`, forbids `allow_always`/`deny_always`, and enforces `answerRefusal()` (must be `pending`, not `irreversible`, not `beyondScope`, `owner === "agent:<caller>"`). Humans can override any agent answer via `POST /api/attention/:actionId/correct`.
- **Second-member delivery gate (`delivery-gate.ts`):**
  - `producedByEvent()` detects code edits (`toolName === "edit"` or `project_push`; deliberately excludes `write` so reviewers writing reports are not counted as producers).
  - When the front desk finishes a Run, `deliveryNoteOf()` checks whether any completed run by a **different** non-self agent (`!produced`) ran at or after the latest producer. If not, appends a canonical verification warning (and `compareUrl` if pushed) to the delivery message.

## Proposals ("Suggest ≠ Save", ADR 0081)

- **Kinds:** `agent_config`, `workflow_definition`, `project_creation`, `project_update`.
- **Statuses:** `pending → adopted | discarded`.
- **Routes (`proposal/http.ts`):** `GET /api/proposals/pending`, `GET /api/proposals/:kind/:targetId`, `POST /api/proposal-decisions/:id`.
- **"Adopted means applied" (`proposal/apply.ts`):** `POST /api/proposal-decisions/:id` with `{ decision: "adopted", payload? }` applies `agent_config` / `project_creation` / `project_update` atomically (allowing human form overrides on project fields). For `workflow_definition`, it **never** writes the file — it asserts the saved file on disk matches `payload` byte-for-JSON (`ProposalNotApplicable` 400 otherwise). Apply failures return 500 and leave the proposal `pending`.

## See also

- [Proactive & Knowledge](./proactive-and-knowledge.md) — Requirements, Wiki, unified recall, and attention debt
- [Agent Run Execution](./agent-run-execution.md) — Queue snapshots, `pending_action`, and recovery
- [Workspaces & Projects](./workspaces-and-projects.md) — Workspace Bridge, `project_push`, and requirement worktrees
- [Skills & Plugins](./skills-and-plugins.md) — Role-scoped builtin skills (`front` vs `worker`)
