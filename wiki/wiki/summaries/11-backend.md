---
title: "Summary: Backend"
type: summary
created: 2026-06-05
updated: 2026-06-09
source: raw/articles/11-backend.md
tags: [backend, L5, hosting, durable-runs]
---

# 11 — Backend

Always-on agent hosting service (L5 Team Runtime). agentId table + workspace materialization + runner dispatch + HTTP/SSE streaming.

**Durable Runs (M9)**: Execution decoupled from SSE connections. `POST /runs` returns 202 `{ runId }` — forks independent subprocess, events land in [[EventLog]] (fact source). `GET /runs/:id/events` provides SSE projection via `eventLog.subscribe()`. Client disconnect → subscription dropped, run continues. Backend restart → re-discover via `heartbeat_at` freshness + EventLog resubscription.

**run/attempt split**: Logical run crosses multiple subprocesses (interrupt→resume). `run` = logical (stable id), `attempt` = physical (pid, heartbeat). 1:N relationship.

**Heartbeat/reaper**: `heartbeat_at` updated per AgentEvent (progress, not liveness). Reaper scans periodically (not just restart) — catches frozen processes. `stepStallTimeoutMs` as secondary verification. Single truth source, no bidirectional ping.

**Resume via re-fork**: Backend doesn't hold Checkpointer — forks new attempt subprocess with forwarded checkpointer config. Subprocess entry calls `agent.resume()`. Backend never reads checkpointer content.

**Storage**: Backend holds [[EventLog]] (projection); Runner holds [[Checkpointer]] (resume). EventLog converges (backend-controlled); Checkpointer can be heterogeneous.

**API**: POST /threads/:id/runs (202), GET /runs/:id/events (SSE + Last-Event-ID), POST /runs/:id/cancel (SIGTERM→SIGKILL), POST /runs/:id/resume (re-fork).
