---
title: "Design Principles"
type: concept
created: 2026-06-05
updated: 2026-06-05
sources:
  - raw/articles/00-overview.md
tags: [design, principles, governance]
---

# Design Principles

8 principles governing all architecture decisions. Listed in priority order.

| # | Principle | Meaning |
|---|-----------|---------|
| 1 | **No protocol without proven need** | Fields added only for real pain points, never speculative |
| 2 | **No deep imports** | Cross-package imports only from `index.ts` |
| 3 | **Composition over hooks** | Solve with JS function composition before adding framework hooks |
| 4 | **State belongs to caller by default** | `messages` array owned by caller; runtime appends in-place |
| 5 | **Layer downward dependency** | L4→L3→L2→L1; reverse = bug |
| 6 | **AsyncIterable is the event stream** | No EventBus/Observer — the stream IS the event channel |
| 7 | **One concept, one name** | Same term across all packages and docs |
| 8 | **Rule of three** | Extract abstraction only on third repetition |

## Application examples

- **Principle 1**: AgentSpec `schemaVersion` field exists because cross-process version mismatch was a known failure mode
- **Principle 3**: `pipeContextManagers()` is function composition, not a hook chain
- **Principle 4**: `agent.thread.messages` is directly readable/writable by caller; framework never hides it
- **Principle 8**: ContextManager was extracted only after 3 real use cases (token budget, sliding window, tool result truncation)
