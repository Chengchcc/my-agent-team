---
title: "Summary: Framework"
type: summary
created: 2026-06-05
source: raw/articles/02-framework.md
tags: [framework, L3, agent]
---

# 02 — Framework

The L3 assembly layer. Wraps L2's bare `run()` generator into a reusable `Agent` object with orthogonal additions: Thread (named message container + fork), Plugin (4 lifecycle hooks), and 3 internal capabilities (Logger, Checkpointer, ContextManager).

**Agent API**: `{ thread, run(), resume(), fork() }`. Envelope design — all yields are `{ type, payload }`. Single-run guard: second concurrent call throws immediately.

**Execution architecture**: 3-tier (`run`/`resume` → `#runLoop` → `#executeOne`). `#executeOne` returns boolean for interrupt, never throws.

**Key semantics**: ContextManager shapes before Plugin.beforeModel decorates. Checkpointer saves at 5 fixed points. before* errors abort the turn; after* errors are swallowed. Plugin.tools merged at construction with duplicate detection.
