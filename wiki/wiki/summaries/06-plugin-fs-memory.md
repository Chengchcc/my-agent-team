---
title: "Summary: FS Memory Plugin"
type: summary
created: 2026-06-05
source: raw/articles/06-plugin-fs-memory.md
tags: [plugin, memory, fs-memory]
---

# 06 — FS Memory Plugin

Filesystem-persistent memory via `beforeModel` injection + 3 static tools. Two-tier: MEMORY.md (hot path, always injected) + facts/ (cold path, searchable via `memory_search`).

**V1 design**: pure substring search with mtime cache. No embedding, no `.index.json`, no self-compact. Memory is enhancement, not contract — IO errors downgrade to warn, never abort.

**Tools**: `memory_read`, `memory_write` (append-only, no index dual-write), `memory_search` (scoring: tag×3 + title×2 + body×1).

**Self-compact** is future work — periodically promote high-value facts from `facts/` into `MEMORY.md`.
