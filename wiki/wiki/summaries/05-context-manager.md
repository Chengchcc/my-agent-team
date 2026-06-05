---
title: "Summary: ContextManager"
type: summary
created: 2026-06-05
source: raw/articles/05-context-manager.md
tags: [context-manager, token-budget, shaping]
---

# 05 — ContextManager

Decides which messages enter the LLM each turn. Pure function: `shape(ctx, messages) → Message[]`. Returns a view — never mutates `thread.messages` (the source of truth).

**Why extracted**: 3 real use cases exceeded what a single slidingWindow plugin could handle.

5 built-in implementations: passthrough (default), slidingWindow (pair-aware), tokenBudget (3-tier counting), summarizing (LLM compression), toolResultTruncator (cap long results). Composable via `pipeContextManagers()`.

**vs Plugin.beforeModel**: CM answers "which messages" (set selection, runs first); beforeModel answers "how each looks" (element decoration, runs after). Two orthogonal layers.
