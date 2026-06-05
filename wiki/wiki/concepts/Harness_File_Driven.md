---
title: "Harness — File-Driven Form"
type: concept
created: 2026-06-05
updated: 2026-06-05
sources:
  - raw/articles/08-harness.md
  - raw/articles/09-harness-generic.md
tags: [harness, file-driven, workspace]
---

# Harness — File-Driven Form

The adopted harness form (Form B). Agent behavior controlled by **workspace markdown files**, not npm package code. Same `harness-generic` + different workspace = different domain agent.

## Why not per-domain packages

All domains (coding, research, writing) share ≥95% overlap in tools, plugins, and bootstrap. Only system prompt differs. → Converge N packages into 1, move the difference to workspace files.

## Workspace file spec

```text
${workspace}/
├── AGENTS.md              ← Session orchestration, safety defaults
├── SOUL.md                ← Agent identity, tone, hard constraints
├── USER.md                ← User profile (LLM never writes)
├── TOOLS.md               ← Tool environment notes
├── MEMORY.md              ← Long-term facts (fs-memory plugin)
├── facts/                 ← Discrete facts (fs-memory plugin)
├── memory/                ← Daily work log
│   └── YYYY-MM-DD.md      ← Injected today+yesterday at bootstrap
└── skills/                ← Progressive skills
    └── ${skill}/SKILL.md
```

All files optional — missing = empty section. Empty workspace → agent degrades to pure fs-memory + progressive-skill.

## File responsibility split

| Files | Owner | Injection timing |
|-------|-------|-----------------|
| SOUL/USER/TOOLS/AGENTS/daily-log | Harness bootstrap | Once per session |
| MEMORY.md + facts/ | fs-memory plugin | Every turn `beforeModel` |
| skills/*/SKILL.md | progressive-skill plugin | Every turn + lazy load |

Daily-log is NOT a plugin — one-time read at session start, no hook needed. Occam's razor.

## Bootstrap protocol

6-step initialization: (1) concurrent read of 6 workspace files → (2) compose systemPrompt static segment → (3) assemble framework with model + builtin tools + 3 plugins.

## Builtin tools

`read`, `write`, `bash`, `grep`, `glob` — all path-constrained to workspace. Out-of-bounds requests → `is_error: true` tool_result, not throw.

## Backend boundary

Harness only knows `workspace path + threadId + model`. Backend handles `agentId → workspace` mapping, workspace materialization, sandbox, transport. **workspace path** is the sole handoff point.
