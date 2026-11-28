---
name: skills_about
description: Explain how the progressive skill system works — discovering skills from the `# Skills` index, loading bodies via `skill_load`, and resolving `${SKILL_DIR}` paths.
user_invocable: true
---

# Using Skills

## What a skill is

A skill is a directory containing a `SKILL.md` file (with YAML frontmatter `name` and `description`) plus optional helper scripts and reference files.

## Discovering available skills

Every turn's `<system-reminder>` includes a `# Skills` section listing the `name` and `description` of every skill available in this run. Never guess or invent a skill name — check the index first.

## Loading a skill

Call `skill_load` with the exact skill name from the index:

```
skill_load("skills_about")
```

The skill's full instructions are then injected into your context.

## Resolving `${SKILL_DIR}`

Skill instructions may contain `${SKILL_DIR}`, which resolves at load time to the skill's real directory on disk. Use it to run bundled scripts or read companion reference files under that directory.

## Rules

- Load on demand: do not preload every skill upfront; load only when a task matches a skill's description.
- Skills come from the workspace's configured skill roots (assigned skill packs in product runs, or `.oma/skills` / managed skills in standalone runs).
- When two roots define the same skill name, the first root wins.
