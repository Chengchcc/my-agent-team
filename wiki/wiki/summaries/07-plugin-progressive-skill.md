---
title: "Summary: Progressive Skill Plugin"
type: summary
created: 2026-06-05
source: raw/articles/07-plugin-progressive-skill.md
tags: [plugin, skill, progressive-skill]
---

# 07 — Progressive Skill Plugin

Progressive disclosure for skills. Index (~50 tokens/skill) injected every turn; full body loaded on demand via `skill_load(name, offset?)`.

**Structure**: `${dir}/*/SKILL.md` with YAML frontmatter (`name`, `description`) + markdown body. `${SKILL_DIR}` placeholder resolves to skill directory at load time.

**One tool**: `skill_load` with 8000-char pagination. No skill_list (index in system), no skill_search (v1: 10-50 skills, LLM judges), no write tools (skills are user-managed assets).

**Fault tolerance**: Same as fs-memory — skill load failure downgrades to warn, never aborts. Single SKILL.md parse failure skips that skill, others continue.
