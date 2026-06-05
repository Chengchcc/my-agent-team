---
title: "Harness"
type: concept
created: 2026-06-05
updated: 2026-06-05
sources:
  - raw/articles/08-harness.md
  - raw/articles/09-harness-generic.md
  - raw/articles/10-harness-vs-framework.md
tags: [harness, L4, product]
---

# Harness

**Domain-closed, zero-assembly, behavior-locked agent product.** Framework + model adapter + tools + system prompt + plugins, pre-assembled for a specific use case.

## Etymology

"Harness" = 马具/挽具 — the tack that connects a horse (LLM) to a cart (business task). Harness doesn't create new capability — it constrains, assembles, and makes ready.

## Three necessary conditions

| Condition | Meaning |
|-----------|---------|
| **Domain-closed** | Has a concrete hypothesis about what the user is doing |
| **Zero-assembly** | User API takes business concepts (workspace), not assembly concepts (model, tools, plugins) |
| **Behavior-locked** | Same harness, same input → stable behavior. Version upgrades are the only change source |

## Two forms

### Form A: Code-driven
System prompt, tool selection, plugin presets baked into npm package. One harness package per domain.

### Form B: File-driven (adopted)
Behavior controlled by workspace markdown files. Same `harness-generic` package + different workspace files = different domain agent.

See [[Harness_File_Driven]] for the full workspace spec and bootstrap protocol.

## Permanent technical contracts

Harness must **never**:
- Read `process.env` — all config via explicit params
- Assume `process.cwd()` — all paths relative to `workspace`
- Know `agentId`, tenant, sandbox, or HTTP — those are Backend concepts
- Introduce network/transport dependencies (`node:http`, `ws`, `fetch`)
- Parse AGENTS.md as structured config — free markdown, full-text to systemPrompt
