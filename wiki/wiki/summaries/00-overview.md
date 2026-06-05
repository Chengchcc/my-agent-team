---
title: "Summary: Architecture Overview"
type: summary
created: 2026-06-05
source: raw/articles/00-overview.md
tags: [overview, layers, milestones]
---

# 00 — Architecture Overview

Defines the 5-layer agent stack (L1 Protocols → L5 Backend), 13-milestone delivery plan (M1–M9+), 8 design principles, and the core runtime contract.

**Key takeaway**: The stack is built from first principles with strict downward dependency. `run()` is an async generator — AsyncIterable is the event stream. State belongs to the caller by default. Model errors propagate up; tool errors become `is_error: true` tool_results.

**13 architecture docs** cover glossary, framework internals (plugin, checkpointer, context-manager), harness (concept + file-driven implementation + vs-framework comparison), backend, two plugins (fs-memory, progressive-skill), and the AgentSpec wire schema.
