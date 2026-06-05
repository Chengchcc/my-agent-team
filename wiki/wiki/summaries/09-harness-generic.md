---
title: "Summary: Harness Generic"
type: summary
created: 2026-06-05
source: raw/articles/09-harness-generic.md
tags: [harness, file-driven, implementation]
---

# 09 — Harness Generic

Concrete file-driven harness implementation. Same package, different workspace files = different domain agent. All domains ≥95% overlap in tools/plugins — only system prompt differs.

**Workspace spec**: 7 file types across 3 owners (harness bootstrap, fs-memory plugin, progressive-skill plugin). All files optional. AGENTS.md is free markdown, not parsed config.

**Bootstrap**: 6 files concurrent read → systemPrompt composition → framework assembly with 5 builtin tools + 3 plugins.

**Builtin tools**: `read`, `write`, `bash`, `grep`, `glob`. All path-constrained to workspace. Out-of-bounds → `is_error: true`.

**Templates**: Independent directory (`templates/coding/`, `templates/research/`). Backend copies on agent creation. Harness doesn't know templates exist.

**Future work**: template versioning, workspace hot-reload, MEMORY.md self-compact, shared workspace concurrency.
