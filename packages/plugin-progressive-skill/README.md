# @my-agent-team/plugin-progressive-skill

> **Layer:** L3 Plugin &nbsp;|&nbsp; **Depends on:** core, framework, tools-common, gray-matter

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L4  Harness ────┐                        │
│                 │ default plugin         │
│          ┌──────▼───────────────────┐    │
│          │ plugin-progressive-skill  │◄─ HERE
│          │ SKILL.md index + load     │    │
│          │ on-demand skill bodies    │    │
│          └──────────────────────────┘    │
│ L3  Framework    definePlugin()          │
└──────────────────────────────────────────┘
```

## What problem it solves

An agent might have dozens of skills, each with a long `SKILL.md` body. You can't fit them all in the system prompt (would blow the context window). This plugin uses **progressive disclosure**: inject a short index (name + one-line description) into the system prompt, and load the full body only when the agent explicitly requests it via a tool call.

## Progressive loading flow

```
┌──────────────────────────────────────────────────────┐
│ System prompt injection (beforeModel hook)            │
│                                                      │
│   Available skills:                                  │
│   - tdd: Test-driven development with red-green-...   │
│   - diagnose: Disciplined diagnosis loop for...      │
│   - dead-code-sweep: Token-frugal dead code...       │
│                                                      │
│   Use the skill-load tool to read full skill body.   │
└──────────────────────────────────────────────────────┘
        │
        │ Agent decides to use "tdd" skill
        ▼
┌──────────────────────────────────────────────────────┐
│ skill_load("tdd") → reads SKILL.md full body         │
│                                                      │
│   # TDD Skill                                        │
│   ## Red-Green-Refactor Loop                         │
│   1. Write a failing test...                         │
│   2. Write minimum code to pass...                   │
│   3. Refactor...                                     │
│   ...                                                │
└──────────────────────────────────────────────────────┘
```

## SKILL.md format

```markdown
---
name: tdd
description: Test-driven development with red-green-refactor loop
---

# TDD Skill

## Red-Green-Refactor Loop
1. Write a failing test...
```

Frontmatter (`name` + `description`) goes into the index. The body below `---` is loaded on demand.

## Key exports

| Export | What | Why |
|--------|------|-----|
| `progressiveSkillPlugin(opts)` | `→ Plugin` | Progressive skill loading plugin |
| `ProgressiveSkillOptions` | Type | `{ ws, root, maxCharsPerLoad, posixSkillRoot }` |

## Usage

```ts
import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import { createAgent } from "@my-agent-team/framework";

const agent = createAgent({
  model: "...",
  plugins: [
    progressiveSkillPlugin({
      ws: "/agent-workspace",
      maxCharsPerLoad: 20000,
    }),
  ],
});
```

## Dependencies

```
plugin-progressive-skill (this package)
  ↑ depends on: core, framework, tools-common, gray-matter
  ↑ depended on by: harness (as default plugin)
```
