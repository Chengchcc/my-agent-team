---
title: "ContextManager"
type: concept
created: 2026-06-05
updated: 2026-06-05
sources:
  - raw/articles/05-context-manager.md
  - raw/articles/02-framework.md
tags: [framework, context, token-budget]
---

# ContextManager

Framework's **internal capability** that decides "which messages actually go to the LLM" before each `model.stream()` call. A pure function: `(ctx, messages) → Message[]`. Returns a view — **never mutates** `thread.messages`.

## Why not a plugin

Three real use cases (rule of three):
1. Token-count-based truncation (not turn-count)
2. Keep first system message + recent N turns
3. Truncate large tool results to summaries

A single `slidingWindow` plugin couldn't handle all three. Multiple plugins would conflict. → New abstraction.

## Key constraint: don't mutate thread.messages

`thread.messages` is the **source of truth** — persisted by Checkpointer, displayed in UX, used for fork. ContextManager produces a **view** (like a SQL SELECT), never mutates the table.

## Built-in implementations

| CM | What it does |
|----|-------------|
| `passthroughContextManager` | Returns messages unchanged (default) |
| `slidingWindowContextManager` | Keeps last N turns + first K messages; pair-aware deletion |
| `tokenBudgetContextManager` | Accumulates tokens from tail until budget; 3-tier token counting |
| `summarizingContextManager` | Triggers LLM summarization of old messages when threshold hit |
| `toolResultTruncator` | Caps `tool_result` content at max chars |

## Composition

`pipeContextManagers(a, b, c)` chains CMs left-to-right. Errors propagate immediately — no swallowing.

## vs Plugin.beforeModel

| ContextManager | Plugin.beforeModel |
|---------------|-------------------|
| **Which** messages enter LLM (set selection) | **How** each message looks (element decoration) |
| One per agent | Multiple, chained |
| Runs first | Runs after CM |
