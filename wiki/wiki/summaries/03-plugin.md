---
title: "Summary: Plugin"
type: summary
created: 2026-06-05
source: raw/articles/03-plugin.md
tags: [plugin, extension, framework]
---

# 03 — Plugin

Framework's sole extension point. 4 hooks at fixed moments in the agent loop. Exists because some cross-cutting logic must see internal execution nodes spanning multiple steps — pure function wrappers can't do this.

**Two hook categories**: Transformers (`beforeModel`, `beforeTool`) modify data flow and abort on error. Observers (`afterModel`, `afterTool`) trigger side effects and are swallowed on error.

**HookContext** exposes framework's 3 internal capabilities (logger, checkpointer, contextManager) for reading and derivation — not for rewriting framework responsibilities.

**Static tool declarations**: `Plugin.tools?: readonly Tool[]` merged at construction. Duplicate names fail-fast. This is NOT runtime dynamic registration — tool set is fixed for the agent's lifetime.

**Design checklist**: Does it need to see internal execution nodes? Can it be expressed in 4 hooks? What does it depend on? Do instances need inter-communication? Should failure block?
