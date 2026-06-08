# M11 Agent Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four orthogonal agent lifecycle features (Genesis, Growth, Removal, Liveness) across harness, backend, runner-stdio, and CLI packages.

**Architecture:** All four features parasitize the existing M9/M10 execution base — zero new execution models, zero new wire protocols, zero schema migrations. Genesis and Growth live in harness/runner-stdio (workspace files + prompts). Removal and Liveness live in backend (DB cleanup + periodic reaping).

**Tech Stack:** TypeScript, Bun, SQLite (via bun:sqlite), Zod (agent-spec), bun:test

---

## Commit 1: harness — bootstrap() BOOTSTRAP.md branch + template

**Files:**
- Create: `packages/harness/src/templates/BOOTSTRAP.md`
- Modify: `packages/harness/src/bootstrap.ts`
- Modify: `packages/harness/src/bootstrap.test.ts`

### Task 1.1: Write BOOTSTRAP.md template file

- [ ] Create `packages/harness/src/templates/BOOTSTRAP.md` with the genesis guide content

### Task 1.2: Add BOOTSTRAP_TEMPLATE export to bootstrap.ts

- [ ] Inline the template as a TS constant in `bootstrap.ts` (use Bun's `import ... with { type: "text" }` or a raw string)
- [ ] Export `BOOTSTRAP_TEMPLATE` alongside `bootstrap`

### Task 1.3: Modify bootstrap() logic

- [ ] Check `BOOTSTRAP.md` before reading 6 identity files
- [ ] If BOOTSTRAP.md exists with non-empty content → return its content directly
- [ ] If 6 files all empty AND no BOOTSTRAP.md → return BOOTSTRAP_TEMPLATE (not old fallbackSystemPrompt)

### Task 1.4: Write/update tests

- [ ] BOOTSTRAP.md present → returns content directly
- [ ] BOOTSTRAP.md present → skips reading other identity files
- [ ] Empty workspace + no BOOTSTRAP.md → returns BOOTSTRAP_TEMPLATE (not old "generic agent")
- [ ] BOOTSTRAP_TEMPLATE is non-empty string with expected content
- [ ] Full/partial workspace regression tests unchanged

---

## Commit 2: harness — reflect.ts (reflectionGuidance)

**Files:**
- Create: `packages/harness/src/reflect.ts`
- Create: `packages/harness/src/reflect.test.ts`
- Modify: `packages/harness/src/index.ts`

### Task 2.1: Write reflect.ts

- [ ] Export `reflectionGuidance()` function returning a reflection prompt string
- [ ] Prompt: "reflect on what you learned → write memory/{today}.md → optionally edit SOUL/USER"
- [ ] Include weak constraint: "回流 SOUL.md 时追加/微调，勿覆盖已有核心边界"

### Task 2.2: Write tests

- [ ] `reflectionGuidance()` returns non-empty string
- [ ] Contains key phrases: "memory", "SOUL.md", "write tool"

### Task 2.3: Export from index.ts

- [ ] Add `export { reflectionGuidance } from "./reflect.js"` to index.ts

---

## Commit 3: workspace — materializeWorkspace BOOTSTRAP.md + purgeWorkspace

**Files:**
- Modify: `apps/backend/src/infra/workspace.ts`
- Create: `apps/backend/src/infra/workspace.test.ts` (or add tests to existing)

### Task 3.1: materializeWorkspace — copy BOOTSTRAP.md for empty workspaces

- [ ] After template copy, check if `SOUL.md` exists in workspace
- [ ] If no SOUL.md → import `BOOTSTRAP_TEMPLATE` from harness, writeFile to `BOOTSTRAP.md`
- [ ] Template-handling: if template dir provided AND template has SOUL.md → skip BOOTSTRAP.md

### Task 3.2: purgeWorkspace function

- [ ] `purgeWorkspace({ workspaceRoot, agentId })` → `rm -rf {workspaceRoot}/{agentId}`
- [ ] Path traversal guard: `path.resolve(wsPath)` must start with `path.resolve(workspaceRoot)`
- [ ] Idempotent: ENOENT → no error

### Task 3.3: Tests

- [ ] Empty workspace → BOOTSTRAP.md written
- [ ] Template with SOUL.md → no BOOTSTRAP.md
- [ ] purgeWorkspace removes directory
- [ ] purgeWorkspace idempotent (second call no error)
- [ ] purgeWorkspace rejects `../` traversal

---

## Commit 4: agent-spec — no changes (confirmed)

**No files changed.** The grilled decision was `stepStallTimeoutMs` stays in BackendConfig only, does not enter AgentSpec. This commit is a no-op; skip.

---

## Commit 5: runner-stdio — heartbeat→progress + reflect injection

**Files:**
- Modify: `packages/runner-stdio/src/entry.ts`
- Modify: `packages/runner-stdio/src/entry.test.ts`

### Task 5.1: Remove independent heartbeat setInterval

- [ ] Delete the `setInterval` heartbeat block
- [ ] Delete `heartbeatTimer` and `hbDb` variables
- [ ] Keep `heartbeatIntervalMs` config field but repurpose as throttle

### Task 5.2: Add progress heartbeat after each sink.append()

- [ ] After `await sink.append(...)`, add throttled heartbeat: `UPDATE attempt SET heartbeat_at = now() WHERE attempt_id = ?`
- [ ] Throttle: only write if `now - lastHeartbeat >= heartbeatIntervalMs`
- [ ] Use a local `lastHeartbeat` variable tracking last write time

### Task 5.3: Add reflect() call after run loop

- [ ] Snapshot `BOOTSTRAP.md` existence BEFORE first `agent.run()`
- [ ] After first `agent.run()` loop completes normally:
  - If genesis mode (BOOTSTRAP.md was present at start) → skip reflect
  - If not genesis mode → run second `agent.run(reflectionGuidance())` loop
- [ ] Second loop events also go through sink.append + writeEvent
- [ ] On error in reflect loop: log but don't fail the run (best-effort)

### Task 5.4: Tests

- [ ] Heartbeat updated after each appended event (verify via mock sink that records calls)
- [ ] Heartbeat throttled: rapid events within interval → only first triggers update
- [ ] No heartbeat when no sink configured (backward compat)
- [ ] Genesis mode (BOOTSTRAP.md present) → reflect skipped
- [ ] Non-genesis mode → reflect runs after main loop
- [ ] Reflect events appended to EventLog

---

## Commit 6: backend/supervisor — reaper

**Files:**
- Modify: `apps/backend/src/features/run/supervisor.ts`
- Modify: `apps/backend/src/config.ts`
- Create/modify: `apps/backend/src/features/run/supervisor.test.ts`

### Task 6.1: Extract reapStaleRuns() method

- [ ] Extract stale-run detection from `rediscover()` into private `#reapStaleRuns()`
- [ ] Query: `SELECT attempt.*, run.thread_id FROM attempt JOIN run USING (run_id) WHERE attempt.ended_at IS NULL`
- [ ] For each stale attempt (age > heartbeatTimeoutMs):
  - `kill(pid, 0)` secondary check
  - Mark `attempt.ended_at` + `run.status = 'interrupted'`
  - `eventLog.append(threadId, runId, { type: "interrupted", payload: { reason: "heartbeat_timeout" } })`
  - Call `#onRunComplete` listeners
- [ ] `rediscover()` calls `#reapStaleRuns()` + its own re-register logic

### Task 6.2: Add reaper setInterval in constructor

- [ ] `setInterval(() => this.#reapStaleRuns(), reaperIntervalMs)`
- [ ] Store timer reference for cleanup

### Task 6.3: Clean up timer in dispose()

- [ ] `clearInterval(this.#reaperTimer)`

### Task 6.4: Add config defaults

- [ ] Add `reaperIntervalMs` to BackendConfig (default `min(heartbeatTimeoutMs/2, 30_000)`)
- [ ] Add `stepStallTimeoutMs` to BackendConfig (default `300_000`)
- [ ] Update `heartbeatTimeoutMs` default to `60_000` in loadConfig

### Task 6.5: Tests

- [ ] reaper marks stale attempts as interrupted
- [ ] reaper appends terminal EventLog event
- [ ] reaper triggers onRunComplete (lock release)
- [ ] reaper does NOT reap fresh heartbeats
- [ ] dispose() clears the timer
- [ ] stepStallTimeoutMs secondary check prevents false positives

---

## Commit 7: backend/agent — hardDelete

**Files:**
- Modify: `apps/backend/src/features/agent/ports.ts`
- Modify: `apps/backend/src/features/agent/service.ts`
- Modify: `apps/backend/src/features/agent/http.ts`
- Modify: `apps/backend/src/features/agent/adapter-sqlite.ts`
- Modify: `apps/backend/src/features/agent/service.test.ts`
- Modify: `apps/backend/src/features/agent/http.test.ts`

### Task 7.1: Add hardDelete to AgentPort

- [ ] `hardDelete(id: string): Promise<{ deletedAgent: boolean; deletedThreads: number; deletedMembers: number }>`

### Task 7.2: Implement hardDelete in sqliteAgentAdapter

- [ ] `PRAGMA foreign_keys = ON`
- [ ] Collect threadIds: `SELECT id FROM threads WHERE agent_id = ?`
- [ ] Delete checkpoint_messages/interrupts/events by threadId
- [ ] Delete threads (CASCADE to run/attempt in backend.db if FK enabled)
- [ ] Delete member rows: `DELETE FROM member WHERE agent_id = ?`
- [ ] Delete agent row
- [ ] All in single transaction

### Task 7.3: Add hardDelete to AgentService

- [ ] Two-layer active check: events.db attempt query + activeConversations Set
- [ ] Call port.hardDelete (backend.db transaction)
- [ ] Clean events.db: delete run/attempt/event_log for agent's threads
- [ ] Call purgeWorkspace
- [ ] Inject events.db access + purgeWorkspace dependency

### Task 7.4: Add ?hard=true to HTTP DELETE

- [ ] Parse `?hard` query param
- [ ] `true` → `hardDelete`, `false`/absent → `archive`
- [ ] Return 409 AgentBusyError if active

### Task 7.5: Tests

- [ ] hardDelete removes agent + threads + checkpoint + member rows from backend.db
- [ ] hardDelete removes run/attempt/event_log from events.db
- [ ] hardDelete calls purgeWorkspace
- [ ] hardDelete with active run → 409
- [ ] DELETE without ?hard → archive (soft delete, regression)

---

## Commit 8: CLI — agent rm --hard

**Files:**
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/cli.test.ts`

### Task 8.1: Add --rm=<id> flag

- [ ] Parse `--rm=<id>` from process.argv
- [ ] If `--hard` flag also present → `DELETE /api/agents/:id?hard=true`
- [ ] Otherwise → `DELETE /api/agents/:id` (soft archive)
- [ ] Confirmation prompt: "This will permanently delete agent <id> and all its data. Continue? (y/N)"
- [ ] Print result and exit (don't enter REPL)

### Task 8.2: Tests

- [ ] `--rm=<id> --hard` sends DELETE with ?hard=true
- [ ] `--rm=<id>` without --hard sends DELETE without ?hard
- [ ] Confirmation required before delete
- [ ] Non-existent backend URL → error message

---

## Commit 9: e2e tests

**Files:**
- Create: `apps/backend/tests/e2e/m11-lifecycle.test.ts`

### Task 9.1: Genesis e2e

- [ ] Create agent with empty workspace → verify BOOTSTRAP.md exists
- [ ] Run agent with stub model that simulates genesis conversation
- [ ] Verify SOUL.md + USER.md created
- [ ] Verify BOOTSTRAP.md deleted
- [ ] Run again → verify normal identity compose (not genesis mode)

### Task 9.2: Growth e2e

- [ ] Run agent (non-genesis) with stub model
- [ ] Verify memory/{today}.md written
- [ ] Run again → verify memory content appears in system prompt

### Task 9.3: Liveness e2e

- [ ] Start run with hanging model (never resolves)
- [ ] Wait for reaper to detect stale heartbeat
- [ ] Verify run status = 'interrupted'
- [ ] Verify M10 conversation lock released
- [ ] Uses real fork (not in-proc mock)

---

## Commit 10: docs sync

**Files:**
- Modify: `docs/architecture/11-backend.md` (already partially done)
- Modify: `docs/architecture/13-event-log.md` (already partially done)
- Modify: `docs/architecture/14-conversation.md` (if needed for lock release linkage)
- Create: `docs/superpowers/retros/2026-06-08-m11-retro.md`

### Task 10.1: Sync architecture docs

- [ ] Verify 11-backend.md reflects reaper defaults + stepStallTimeoutMs placement
- [ ] Verify 13-event-log.md reflects heartbeat as single-source progress signal
- [ ] Verify 14-conversation.md references reaper as lock release path

### Task 10.2: Write M11 retro

- [ ] Delivery vs spec comparison
- [ ] Review findings
- [ ] Fixes applied during implementation
- [ ] Known limitations

---

## Verification Checkpoint

After all commits:

- [ ] `bun run test` — all green including 3 e2e
- [ ] `bun run build` — all packages pass
- [ ] `bun run typecheck` — no new errors
- [ ] `bun run lint` — no new warnings
- [ ] M9/M10 regression: all existing tests pass unchanged
- [ ] No backend.db / events.db schema changes
