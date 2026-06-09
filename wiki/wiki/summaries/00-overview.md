---
title: "Summary: Architecture Overview"
type: summary
created: 2026-06-05
updated: 2026-06-09
source: raw/articles/00-overview.md
tags: [overview, layers, milestones]
---

# 00 — Architecture Overview

Defines the 6-layer agent stack (L1 Protocols → L6 Surfaces), milestone delivery plan (M1–M15+), 8 design principles, and the core runtime contract.

**Key takeaway**: The stack is built from first principles with strict downward dependency. `run()` is an async generator — AsyncIterable is the event stream. State belongs to the caller by default. Vision: humans and agents are first-class team members, interacting via Conversation/Member abstractions.

**15 architecture docs** cover glossary, framework internals (plugin, checkpointer, context-manager), harness (concept + file-driven implementation + vs-framework comparison), backend (including Durable Runs), two plugins (fs-memory, progressive-skill), AgentSpec wire schema, EventLog (M9 execution fact source), and Conversation/Member (multi-agent collaboration base).

**Milestone status**: M1–M8 complete. M9 (Durable Runs) in progress — EventLog port, run/attempt split, heartbeat/reaper, SSE decoupling. M10 (Conversation/Member) designed, pending implementation.
