---
title: "FS Memory Plugin"
type: concept
created: 2026-06-05
updated: 2026-06-05
sources:
  - raw/articles/06-plugin-fs-memory.md
tags: [plugin, memory, filesystem]
---

# FS Memory Plugin

**Filesystem-persistent memory plugin.** LLM incrementally writes facts via tools; plugin auto-injects MEMORY.md into system prompt every turn via `beforeModel`.

## Why it exists

Cross-session amnesia — user preferences, project background, compliance facts don't belong in conversation history but must be visible every turn.

## Directory structure

```
${dir}/
├── MEMORY.md              ← Always injected (hot path)
└── facts/
    └── YYYY-MM-DD-slug.md ← Discrete facts (cold path, searchable)
```

Two-tier: MEMORY.md is hot (every turn), facts/ is cold (on-demand via `memory_search`).

## Three tools (static declaration)

| Tool | Purpose |
|------|---------|
| `memory_read` | Read MEMORY.md or a fact file |
| `memory_write` | Append fact to `facts/ts-slug.md` (append-only, no index) |
| `memory_search` | Substring search across facts with scoring |

V1: pure substring search + mtime cache. No embedding, no `.index.json` — avoids dual-write consistency issues.

## Fault tolerance

Memory is **enhancement, not contract**. IO errors → `logger.warn` + pass-through. Tool errors → normal `is_error: true` tool_result. Never abort the agent over a disk read failure.

## Self-compact

NOT in v1. Future: periodically promote high-value facts from `facts/` into `MEMORY.md` to prevent infinite fact growth.
