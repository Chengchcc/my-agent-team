---
title: "Backend"
type: concept
created: 2026-06-05
updated: 2026-06-09
sources:
  - raw/articles/11-backend.md
  - raw/articles/13-event-log.md
  - raw/articles/14-conversation.md
  - raw/articles/10-harness-vs-framework.md
tags: [backend, L5, hosting, durable-runs]
---

# Backend

The **L5 Team Runtime** — an always-on HTTP process managing multiple agent instances, maintaining agentId metadata, materializing workspaces, dispatching runners, and exposing HTTP/SSE to L6 Surfaces.

## Durable Runs: execution decoupling

Pre-M9, `POST /run` returned an SSE stream bound to a single HTTP connection — client disconnect = run lost. Post-M9, three concerns are orthogonal:

```
POST /api/threads/:id/runs
  → fork runner-stdio subprocess (independent PID)
  → subprocess writes each AgentEvent → eventLog.append() (fact source)
  → returns 202 { runId } (SSE decoupled)

GET /api/runs/:id/events
  → eventLog.subscribe({ runId, afterSeq }) (read-only projection)
```

- **Executor** (subprocess) only calls `append`; **Projector** (SSE) only calls `subscribe`. They don't know each other — sole communication medium is [[EventLog]].
- Client disconnect → only cancels subscription, **not** the run.
- **Writing to EventLog is done by runner entry**, not harness. `agent.run()` only yields events; entry consumes and appends. EventLog concept never descends to framework/harness.

## Data model: run (logical) / attempt (physical)

A logical run spanning interrupt→resume crosses **multiple subprocesses**. Split into two entities:

| Entity | Lifecycle | Fields |
|--------|-----------|--------|
| **run** (logical) | First start → terminal state, across multiple interrupt/resume | `run_id, thread_id, status, started_at` |
| **attempt** (physical) | Single subprocess execution | `attempt_id, run_id, pid, heartbeat_at, started_at, ended_at` |

1 run : N attempts. interrupt→resume = new attempt (same run_id). EventLog events carry `run_id` shared across all attempts → frontend sees one continuous stream even when subprocesses change.

## Liveness & heartbeat

**Single truth source**: `attempts.heartbeat_at` (DB column). `kill(pid,0)` is abandoned — PID reuse across restarts makes it unreliable.

- Subprocess entry updates heartbeat on **every AgentEvent produced** (progress signal, not mere liveness)
- Backend restart: scans `runs.status='running'` → fresh heartbeat → re-discover via `eventLog.subscribe()`; stale heartbeat → mark interrupted
- **Reaper**: runtime periodic scan (not just restart-triggered) — catches stuck runs where process is alive but task is frozen. `heartbeatTimeoutMs` determines staleness; `stepStallTimeoutMs` as secondary verification (BackendConfig only, not in AgentSpec)

## Resume: re-fork, not direct call

Backend doesn't hold [[Checkpointer]] and doesn't call `agent.resume()`. Instead:

```
POST /api/runs/:id/resume {approved, message}
  → backend looks up original AgentSpec (with storage.checkpointer config)
  → forks new attempt subprocess with spec.mode="resume" + resumeCommand
  → subprocess entry: agent.resume(cmd) → consumeInterrupt → continue loop
  → events append to EventLog (same run_id)
  → backend SSE: subscribe({runId}) continues seamlessly
```

Backend only **forwards** checkpointer connection config — never reads its content. Permanently unaware of checkpointer medium.

## API surface (post-M9)

```
POST /api/threads/:id/runs    — Start run subprocess → 202 { runId } (no longer SSE)
GET  /api/runs/:id/events     — SSE projection, supports Last-Event-ID reconnect
POST /api/runs/:id/cancel     — 204, SIGTERM → SIGKILL after cancelGraceMs
POST /api/runs/:id/resume     — Fork new attempt subprocess, same run_id
GET  /api/runs/:id            — Run metadata (status, timestamps, current attempt)

POST   /agents                — Create agent + materialize workspace
DELETE /agents/:id            — Destroy + archive workspace
```

## Storage ownership

| Store | Held by | Purpose |
|-------|---------|---------|
| [[EventLog]] | **Backend** composition root | SSE projection fact source |
| [[Checkpointer]] | **Runner** subprocess (backend never touches) | Agent resume authority |

EventLog converges (all runners share same backend-controlled store); Checkpointer can be heterogeneous (per-runner: sqlite/redis/memory).

## Key invariants

- Backend is **assembly + forwarding** for resume — never reads checkpointer content
- Heartbeat is **progress**, not liveness — tied to AgentEvent production, not independent timer
- EventLog convergence: `storage.eventLog` backend-determined; `storage.checkpointer` runner-chosen
- Reaper reuses existing heartbeat column + `onRunComplete` callback — zero new tables/protocols
