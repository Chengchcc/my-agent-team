---
title: Agent Run Execution
description: Complete Agent Run lifecycle — enqueueAndAcquire transaction, input modes, 9-stage dispatch machine, watchdogs, durable HITL pending_action, atomic terminal commit, crash recovery, and shutdown drain
tags: [backend, runs, execution, hitl]
---

# Agent Run Execution

`Agent Run` (`agent_run`) is the unique product execution identity. Every Run binds one queued input on one `agent_context_branch`, spawns one ephemeral ACP child process, fans out transient live events, parks durably on human-in-the-loop (HITL) prompts, and settles atomically into `conversation_ledger` and `agent_context_branch`.

## Authoritative files

- `apps/backend/src/features/agent-run/domain.ts` — Run/queue/action status unions, `pendingActionId()`, domain errors
- `apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts` — Atomic `enqueueAndAcquire` transaction
- `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` — `commitCompletedRun`, `failCommit`, `finalizeRun`, `acquireNextRun`, `setRunProductTools`
- `apps/backend/src/features/agent-run/adapter-sqlite-actions.ts` — `pending_action` lifecycle, risk/scope checks, escalation
- `apps/backend/src/features/agent-run/execution-dispatch.ts` — 9-stage dispatch state machine, watchdogs, settlement
- `apps/backend/src/features/agent-run/execution-live.ts` — Live event bus, telemetry persistence whitelist, approval-first persistence
- `apps/backend/src/features/agent-run/execution-service.ts` — `recover()`, `resumeParkedRun()`, `injectSteer()`, `resolveApproval()`, `stop()`, `dispose()`
- `apps/backend/src/features/agent-run/execution-input.ts` — `buildRunInput()`, first-turn history bridge, Product Context prompt injection
- `apps/backend/src/features/agent-run/budget-gate.ts` — Daily spend cap (`cost.dailyBudgetUsd`)
- `apps/backend/src/features/agent-run/interrupted-jobs.ts` — Deriving unfinished background jobs from previous turn telemetry (ADR 0063)
- `apps/backend/src/features/agent-run/http.ts` — `/api/agent-runs/*`, `/api/tasks`, `/api/pending-actions`, `/api/attention*`, `/api/usage/summary`

## Run & Queue State Machines

- **Active Run statuses** (covered by partial unique index `idx_agent_run_active_branch`): `running`, `waiting` (parked on ≥1 open `pending_action`), `commit_failed` (outcome saved, DB commit failed; holds branch lock).
- **Terminal Run statuses:** `completed`, `failed`, `aborted`, `timeout`.
- **Queue row (`branch_input_queue`) statuses:** `pending → delivering → delivered` (or `cancelled`). Ordering is strictly monotonic by `seq`.
- **Pending action (`pending_action`) statuses:** `pending → resolved | cancelled`. Action ID is always `"${runId}:${callId}"`.

## Input Acquisition (`enqueueAndAcquire`) & Input Modes

`enqueueAndAcquire` (`adapter-sqlite-enqueue.ts`) runs inside a single SQLite immediate transaction:

1. Inserts the input row into `branch_input_queue` with the full request-time `configSnapshot` (`modelRef`, `configRevision`, `workspaceRoot/Access`, `systemPrompt`, `skillRoots`, `permissionMode`, `toolPolicy`, `workflowBudgetTokens`, `authorization`, `parentRunId`). Replaying an identical `(branchId, inputIdempotencyKey, mode, message)` is idempotent; payload mismatch throws.
2. Checks for an active Run on `branchId`. If present, returns `{ acquired: false, queued: true }`.
3. If `mode === "steer"` and no active Run exists, marks the input `cancelled` immediately (steer never degrades to a queued normal run).
4. Validates branch-to-conversation ownership and `branch.backendKind === defaultModel.backendKind`.
5. Performs optimistic `revision` CAS on `agent_context_branch`.
6. Syncs up to the latest **20** non-undone, non-internal ledger messages after `branch.ledgerCursor` into `agent_context_entry`, advancing `ledgerCursor` and `leafEntryId`.
7. Inserts `agent_run` (`status: "running"`) and flips the queue row to `status: "delivering", runId`.

**Mode routing on the ACP rail:**
- When a branch is idle, normal inputs acquire immediately.
- When a Run is live, `injectSteer` delivers `_session/steering` ONLY if the child supports steering (`_meta.steering.supported === true`); if no live handle exists, steer fails and cancels the input unless `{ keepIfIdle: true }` is passed.
- Queued `normal` / `follow_up` inputs wait in `branch_input_queue` until `acquireNextRun(branchId)` promotes the oldest `pending` non-`steer` row into a **brand-new `agent_run`** using **that queued input's own frozen `configSnapshot`** (never inheriting the prior Run's config).

## 9-Stage Dispatch State Machine (`execution-dispatch.ts`)

Every acquired Run executes through nine named stages (logged to stderr when `OMA_DEBUG=1`):

```text
1. load_run            Read agent_run row; abort if already terminal
2. budget_gate         Check today's catalog-priced spend vs settings["cost.dailyBudgetUsd"]
3. model_preflight     Verify harness & model availability (422 DomainError on unknown harness/model)
4. claim_input         Claim bound queue input (up to 8 iterations; cancels orphan steers;
                       includes already-delivered input when resuming a parked HITL Run)
   ── acquire workspaceLocks.withLock(workspace.root) ──
5. resolve_workspace   Requirement worktree (shared: true) > error if project room lacks one >
                       agent workspace (shared: false). Always grants access: "read_write".
6. set_product_tools   Write-once persist run.productTools manifest before child spawn
7. context_projection  projectAgentContext(branchId) + collectRecall() + interrupted-jobs block
8. backend_execute     Mint per-run bearer token → resolveContinuationRef() → load lastTodo →
                       rewriteWorkspaceBridge() → backend.execute(buildRunInput(...)) →
                       mark input "delivered" → forward live events
   ── if workspace.shared === false, release workspace lock immediately; shared holds until settle ──
9. settle_outcome      Persist scoped cliSessionRef → append deliveryNote if unverified →
                       commitCompletedRun() (or failCommit / finalizeRun) → cancel open actions →
                       notify parent dispatcher → acquire_next (promote next queued input)
```

In `finally`, dispatch unconditionally clears `inflight`/`liveRuns` maps, revokes the per-run bearer token (`productToolsTokenRegistry.revoke(runId)`), and cleans up `liveEvents`.

## Watchdogs & Cancellation

- **Wall-clock timeout (`BACKEND_RUN_TIMEOUT_MS`, default `30 min`):** when the timer fires, if any `pending_action` for the Run is still `pending`, the watchdog defers and re-arms instead of killing a Run waiting on a human; otherwise calls `backend.stop(runId)` → `aborted`.
- **Silence watchdog (default `90 s`, polled every `max(500 ms, floor(window / 3))`):** exempt while the Run has an open native tool call (`liveEvents.hasOpenToolCall`) or a pending HITL action; otherwise stops the mute child.
- **Explicit cancel (`POST /api/agent-runs/:runId/cancel`):** returns `already_terminal` on terminal Runs; stops live children via `backend.stop(runId)`; for DB zombies (active row, no live child), directly aborts the Run, cancels pending actions and bound inputs, and promotes `acquireNextRun`.

## Live Events, Telemetry & Durable HITL

`execution-live.ts` (`createLiveEventBus`) fans out every `BackendEvent`:

- **Live surfaces:** forwards to `AhpChatWriter` (`/ws/ahp`). Observer errors are swallowed so delivery issues never disrupt the Run.
- **Telemetry persistence (`agent_run_event`):** persists only `TELEMETRY_EVENT_TYPES` (`status`, `native_tool_started`, `native_tool_completed`, `delegation_*`, `job_state`, etc.) while excluding `heartbeat`, `text_delta`, and `thinking_delta`.
- **Approval-before-broadcast ordering:** on `approval_requested`, the bus **awaits `createPendingAction` in SQLite BEFORE broadcasting** to surfaces. If DB persistence fails, the event is dropped and the child's fail-closed approval timer denies it.
- **Durable HITL parking & resume (ADR 0038/0039):**
  - First open `pending_action` CASes `agent_run.status` from `running → waiting`.
  - `createPendingAction` inspects `run.risk.irreversible` and `beyondFrozenScope(payload, { toolPolicy })`, stamping `payload.risk` and forcing `owner = "user"` when irreversible or out of scope (otherwise `requestOwnerOf` routes to the front-desk dispatcher; see [Team Coordination](./team-coordination.md)).
  - `consumePendingAction` validates `responseIdempotencyKey` (409 on mismatch) and wakes `waiting → running` only when **zero** sibling pending actions remain.
  - `POST /api/agent-runs/:runId/approval`: if the child is live, calls `backend.resolveApproval()` first then consumes the DB row; if the child died while parked (`status === "waiting"`, no live handle), consumes durably and calls `resumeParkedRun(runId)`, which stashes `listDecidedActions(runId)` in `resumeInbox` and re-dispatches the same `runId` with `input.resume.decisions`.

## Atomic Terminal Commit & Crash Recovery

- **`commitCompletedRun` (`adapter-sqlite-runs.ts`):** idempotent if already `completed`; accepts `running | waiting | commit_failed`; normalizes canonical messages (`run:<runId>:assistant:0` for the final assistant reply, `run:<runId>:tool:<index>` for tool results); inserts into `conversation_ledger` with `ON CONFLICT DO NOTHING` on `(agent_run_id, message_index)`; dedupes `agent_context_entry` by `(treeId, ledger_message, ledgerSeq)`; bumps `agent_context_branch` (`leafEntryId`, `ledgerCursor`, `revision + 1`); and marks `agent_run.status = "completed"` — all in one transaction.
- **`failCommit`:** if the terminal commit throws, transitions the Run to `commit_failed` with `terminal_result` preserved; the branch remains occupied so no subsequent Run can overwrite history.
- **Boot `recover()` (`execution-service.ts`, invoked before Workflow `recover()`):**
  1. Re-dispatches inputs stuck in `delivering` under their existing `runId`.
  2. Promotes pending non-steer inputs on idle branches via `acquireNextRun`.
  3. Re-delivers up to 50 terminal dispatched Runs whose `result_notified_at IS NULL` (at-least-once worker-to-dispatcher notification).
  4. Retries `commit_failed` Runs from saved `terminal_result` without re-spawning the child.
  5. Sweeps active (`running | waiting`) Runs with `delivered` inputs and no live child: **keeps `waiting` Runs that still have `pending` actions** (ADR 0038 parked HITL), aborts all other orphans (`"stale run without live child after restart"`), cancels their pending actions, and promotes the next queued input.
- **Graceful shutdown (`dispose()`):** `main.ts` sets `setBackendShuttingDown(true)` on `SIGTERM`/`SIGINT` before calling `installed.dispose()`, which disposes all backends (killing children and settling their loss as `aborted`, not `failed`) and awaits all in-flight dispatch promises.

## HTTP Control & Read Endpoints (`agent-run/http.ts`)

| Endpoint | Purpose |
|---|---|
| `GET /api/agent-runs` / `GET /api/agent-runs/:runId` | List runs (`status`, `agentId`, `conversationId`, `parentRunId`, `limit` 1..500) and inspect run detail (`verdict`, `verification`, `pendingActions`, `inputs`). |
| `POST /api/agent-runs/:runId/cancel` | Cancel live run or abort DB zombie. |
| `POST /api/agent-runs/:runId/retry-commit` | Retry atomic terminal commit for a `commit_failed` run from its saved `terminal_result` (without re-spawning the child) and promote the next queued input; `200 already_terminal` if already settled, `409` if still `running`/`waiting`. |
| `POST /api/agent-runs/:runId/approval` | Resolve approval (`allow \| allow_always \| deny \| deny_always`); 400 bad body, 404 missing, 409 terminal/consumed. |
| `GET /api/tasks` | Combined view of `branch_input_queue` + `agent_run` (default 100, max 300). |
| `GET /api/pending-actions` | All open `pending_action` rows on active runs (limit 200). |
| `GET /api/attention`, `POST /api/attention/seen`, `POST /api/attention/:actionId/correct`, `GET/PUT /api/attention/draft` | Attention-debt inbox (`awaitingYou`, `waitingAgent`, `unread`), read markers, human override of agent-answered requests, and persistent answer drafts. |
| `GET /api/usage/summary` | Token & cost aggregation (`conversation`, `agent`, `today`, `budget`). |

## See also

- [ACP Backend Contract](./acp-backend-contract.md) — Wire lifecycle beneath `backend_execute`
- [Conversation & Context](./conversation-and-context.md) — Branch revision CAS and `cli_session_ref`
- [Team Coordination](./team-coordination.md) — `requestOwnerOf`, `answerRefusal`, `deliveryNoteOf`, and dispatcher wakeup
- [Data Model](./data-model.md) — Table columns and unique constraints
