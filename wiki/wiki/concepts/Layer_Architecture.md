---
title: "Layer Architecture"
type: concept
created: 2026-06-05
updated: 2026-06-05
sources:
  - raw/articles/00-overview.md
  - raw/articles/10-harness-vs-framework.md
tags: [architecture, layers, design]
---

# Layer Architecture

The my-agent-team stack is 5 layers, each depending only downward.

```mermaid
flowchart TD
    L5[L5 Backend<br/>常驻服务] --> L4[L4 Harness<br/>装配成品]
    L4 --> L3[L3 Framework<br/>装配套件]
    L3 --> L2[L2 Runtime<br/>运行内核]
    L2 --> L1[L1 Protocols<br/>类型契约]
```

## L1 — Protocols

Type contracts: `Message`, `ChatModel`, `Tool`. Zero runtime logic. The vocabulary that all layers above share.

## L2 — Runtime

The `run()` async generator. Messages → model → tools → messages loop. Stateless, minimal — caller owns the messages array.

## L3 — Framework

`createAgent()` API that wraps L2 into a reusable `Agent` object with:
- **Thread** — named message container with fork support
- **Plugin** — 4 lifecycle hooks (beforeModel/afterModel/beforeTool/afterTool)
- **Internal capabilities** — Checkpointer, ContextManager, Logger

## L4 — Harness

Domain-closed, zero-assembly agent product. Two forms:
- **Code-driven**: system prompt baked into npm package
- **File-driven** (adopted): behavior controlled by workspace markdown files (SOUL.md, AGENTS.md, etc.)

## L5 — Backend

Always-on process. Multi-agent management, agentId→workspace mapping, HTTP/SSE streaming, sandbox transparency, runner transport selection.

## Key rules

- Downward dependency only (L4→L3→L2→L1)
- Cross-package imports only from `index.ts`
- AsyncIterable is the event stream — no EventBus
- State belongs to caller by default
