---
title: "Summary: EventLog"
type: summary
created: 2026-06-09
source: raw/articles/13-event-log.md
tags: [event-log, durable-runs, sse, persistence]
---

# 13 — EventLog

EventLog is an **independent port** that extracts "run execution event stream" from Checkpointer into a standalone **append-only, projectable, subscribable** fact source. It solves the first-principle problem: **execution** (run subprocess), **projection** (SSE to frontend), and **HTTP connection lifecycle** must be orthogonal.

**Why split from Checkpointer**: Event stream on Checkpointer Tier 3 works for single-process CLI but breaks durable runs — backend SSE projection would need Checkpointer, but Checkpointer is runner-injected (backend doesn't hold it). Extracting EventLog with a `thread_id` field lets backend project events without ever touching Checkpointer.

**Four iron laws**: (1) Depend on abstract interface, storage details sealed in adapter; (2) `subscribe` is EventLog's read dual, not executor capability; (3) Executor and projector don't know each other — communicate only through EventLog; (4) Executor writes directly to the most durable layer (DB), never relies on backend forwarding.

**Interface**: `EventLog = EventSink + EventSource`. `EventSink` (write side) — `append()` only, for run subprocess. `EventSource` (read side) — `read()` + `subscribe()` for backend SSE projection. Compile-time misuse prevention via interface segregation.

**Built-in implementations**: `postgresEventLog` (LISTEN/NOTIFY + polling fallback), `sqliteEventLog` (polling-only, WAL + busy_timeout), `inMemoryEventLog` (EventEmitter, tests).

**Key invariant**: EventLog converges (all runners write to same backend-controlled storage); Checkpointer can be heterogeneous (per-runner choice). EventLog cannot replace Checkpointer for resume — it stores raw uncut events, not the trimmed input state that agent loop actually fed to the model.
