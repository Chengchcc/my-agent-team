---
title: "my-agent-team/backend"
type: entity
created: 2026-06-05
tags: [package, L5, backend]
---

# apps/backend

L5 backend service. Always-on process: agentId table, workspace materialization, runner dispatch, HTTP/SSE streaming. Depends on harness-generic + agent-spec + adapter-anthropic. Does NOT directly depend on framework (consumed transitively through harness). Delivered in M8.
