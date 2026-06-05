---
title: "Index — My Agent Team Architecture"
type: index
created: 2026-06-05
updated: 2026-06-05
---

# Index — My Agent Team Architecture

> A 5-layer agent stack built from first principles: Protocols → Runtime → Framework → Harness → Backend.

## Navigation
- [[#Concepts]] · [[#Entities]] · [[#Summaries]] · [[#Open Questions]]

## Concepts

### Architecture
- [[Layer_Architecture]] — L1–L5 layer model, downward dependency, cross-layer contracts
- [[Design_Principles]] — 8 principles governing all design decisions

### L2 — Runtime
- [[Agent_Loop]] — The core while-loop: messages → model → tools → messages

### L3 — Framework
- [[Plugin_System]] — Sole extension point: 4 lifecycle hooks + static tool declarations
- [[Checkpointer]] — Persistence, interrupt/resume, 3-tier capability detection
- [[ContextManager]] — Message shaping before LLM calls, 5 built-in strategies

### L3 — Plugin Implementations
- [[FS_Memory_Plugin]] — Filesystem memory: MEMORY.md hot path + facts/ cold path + 3 tools
- [[Progressive_Skill_Plugin]] — Skill progressive loading: index injection + skill_load pagination

### L4 — Harness
- [[Harness]] — Domain-closed, zero-assembly, behavior-locked agent product
- [[Harness_File_Driven]] — File-driven form: workspace files control behavior, bootstrap protocol

### L5 — Backend
- [[Backend]] — Agent hosting service: agentId, workspace materialization, runner, HTTP/SSE
- [[AgentSpec]] — Wire schema: zod-based, dual-validated, version-evolved

## Entities

### Core Packages
- [[my-agent-team_core]] — `@my-agent-team/core` — L1+L2 protocols and runtime
- [[my-agent-team_framework]] — `@my-agent-team/framework` — L3 assembly layer

### Harness
- [[my-agent-team_harness-generic]] — `@my-agent-team/harness-generic` — L4 file-driven harness

### Adapter
- [[my-agent-team_adapter-anthropic]] — `@my-agent-team/adapter-anthropic` — Anthropic ChatModel implementation

### Plugins
- [[my-agent-team_plugin-fs-memory]] — `@my-agent-team/plugin-fs-memory` — FS memory plugin
- [[my-agent-team_plugin-progressive-skill]] — `@my-agent-team/plugin-progressive-skill` — Skill plugin

### Backend & Runner
- [[my-agent-team_backend]] — `apps/backend` — L5 backend service
- [[my-agent-team_runner-stdio]] — `@my-agent-team/runner-stdio` — stdio runner entry
- [[my-agent-team_agent-spec]] — `@my-agent-team/agent-spec` — Wire schema package

## Summaries (chronological by doc number)

- [[00-overview]] — Architecture overview, 4-layer model, milestones, design principles
- [[01-glossary]] — Unified terminology across layers
- [[02-framework]] — L3 Framework: Agent, Plugin, Checkpointer, ContextManager, Logger
- [[03-plugin]] — Plugin extension mechanism: 4 hooks, HookContext, static tools
- [[04-checkpointer]] — Persistence, interrupt/resume, capability detection, file/in-memory impl
- [[05-context-manager]] — Message shaping, token budget, sliding window, summarization, truncation
- [[06-plugin-fs-memory]] — FS memory plugin: MEMORY.md + facts/ + memory_read/write/search
- [[07-plugin-progressive-skill]] — Progressive skill plugin: SKILL.md index + skill_load tool
- [[08-harness]] — Harness concept: two forms, bootstrap protocol, backend boundary, contracts
- [[09-harness-generic]] — File-driven harness: workspace spec, builtin tools, templates, API
- [[10-harness-vs-framework]] — Framework vs Harness vs Backend: boundaries, gray zones, anti-patterns
- [[11-backend]] — Backend: agentId, workspace materialization, runner transport, agent pool, SSE
- [[12-agent-spec]] — AgentSpec wire schema: zod, version evolution, harness independence

## Open Questions
- Q1: Will harness-generic need hot-reload for workspace files mid-session?
- Q2: When does the project outgrow "small agent stack" and need distributed infrastructure?
- Q3: Should AgentSpec switch to Protobuf for cross-language runners (Go/Rust/Python)?
