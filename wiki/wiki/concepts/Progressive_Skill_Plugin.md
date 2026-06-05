---
title: "Progressive Skill Plugin"
type: concept
created: 2026-06-05
updated: 2026-06-05
sources:
  - raw/articles/07-plugin-progressive-skill.md
tags: [plugin, skill, progressive-loading]
---

# Progressive Skill Plugin

**Skill progressive-loading plugin.** Injects skill index (name + description) into system prompt every turn; LLM calls `skill_load` tool to fetch full body on demand.

## Why it exists

30 skills × 2KB = 60KB of system prompt bloat, most skills unused per turn. Progressive disclosure: ~50 tokens/skill index (~1.5KB total) always visible, full body loaded only when needed.

## Directory structure

```
${dir}/
├── pdf-extract/
│   ├── SKILL.md            ← frontmatter (name, description) + body
│   ├── extract.py          ← Skill-owned resources
│   └── examples/
└── docx-generate/
    └── SKILL.md
```

SKILL.md format: YAML frontmatter (`name`, `description`) + markdown body. Body can reference `${SKILL_DIR}` placeholder for resource paths.

## Injection strategy

**Phase 1** — `beforeModel`: scan all `SKILL.md` frontmatters, render index block appended to system message.

**Phase 2** — `skill_load(name, offset?)`: LLM calls tool → returns body (or paginated chunk with `next_offset`). Pagination at 8000 chars (~2K tokens) — active, not passive truncation.

## One tool

Only `skill_load`. No `skill_list` (index already in system), no `skill_search` (v1: 10–50 skills, LLM judges by description), no `skill_create`/`skill_edit` (skills are user-managed assets).

## vs FS Memory

| Dimension | fsMemory | progressiveSkill |
|-----------|----------|-------------------|
| Injected content | MEMORY.md full text | SKILL.md frontmatter index |
| Pagination | No | Yes (`skill_load(offset)`) |
| Write path | `memory_write` tool | None (user-managed) |
| Search | `memory_search` | Not needed (index always visible) |
