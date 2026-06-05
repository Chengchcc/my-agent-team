---
title: "Summary: Backend"
type: summary
created: 2026-06-05
source: raw/articles/11-backend.md
tags: [backend, L5, hosting]
---

# 11 — Backend

Always-on agent hosting service. agentId table + workspace materialization + runner dispatch + HTTP/SSE streaming.

**4 runner transports**: in-proc, stdio subprocess, HTTP SSE, WebSocket. Runner entry ≤50 lines — deserialize AgentSpec, assemble harness, serialize events.

**Sandbox transparency**: bind-mount workspace, spawn runner inside. Harness sees only a regular path. Swap sandbox implementation → zero code changes.

**REST API**: POST /agents (create), POST /agents/:id/run (SSE stream), POST /agents/:id/abort, POST /agents/:id/resume, GET /agents/:id/thread, DELETE /agents/:id.

**Agent Pool**: spawn(agentId, input, threadId) → AsyncIterable. Concurrent model: per-agentId parallel, per-threadId serial (framework guard). Graceful shutdown: wait for current turns, save, then exit.
