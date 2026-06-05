# My Agent Team — Architecture Knowledge Base

> Schema document — read at the start of every session together with `wiki/index.md`.

## Scope

This wiki covers the architecture of **my-agent-team** — a small agent stack built from first principles. 5 layers (L1–L5): Protocols → Runtime → Framework → Harness → Backend.

What this wiki covers:
- Layer design and responsibilities
- Component interfaces and semantics
- Cross-layer boundaries and contracts
- Design principles and permanent technical contracts
- Milestone delivery history

What this wiki deliberately excludes:
- Implementation details (code level)
- Test plans and test infrastructure
- Operational runbooks

## Operations

This wiki follows the llm-wiki skill's five operations: `compile`, `ingest`, `query`, `lint`, `audit`.
Every operation appends an entry to `log/YYYYMMDD.md`.

## Naming conventions

- **Concept pages** (`wiki/concepts/`): Title Case noun phrases (e.g. `Agent_Loop`, `Plugin_System`).
- **Folder-split concepts** (`wiki/concepts/<topic>/`): used when a topic exceeds ~1200 words. Contains `index.md` + one file per aspect.
- **Entity pages** (`wiki/entities/`): Proper names — packages (`@my-agent-team/core`), people, tools.
- **Summary pages** (`wiki/summaries/`): kebab-case source slug matching the architecture doc number.

### Diagrams and formulas
- All diagrams are **mermaid**. No ASCII art.
- All formulas are **KaTeX** (inline `$...$` or block `$$...$$`).

### Raw file policy
- Architecture docs are markdown → copied into `raw/articles/`.
- External references (Karpathy Gist, Anthropic docs) → create pointer files in `raw/refs/`.

## Current articles

### Concepts
- [[Agent_Loop]] — The core while-loop: messages → model → tools → messages
- [[Plugin_System]] — Framework's sole extension point: 4 hooks + static tool declarations
- [[Checkpointer]] — Persistence & interrupt/resume capability
- [[ContextManager]] — Message shaping before LLM calls
- [[Harness]] — Domain-closed, zero-assembly, behavior-locked agent product
- [[Harness_File_Driven]] — Workspace files (SOUL/AGENTS/USER/TOOLS) control agent behavior
- [[Backend]] — Agent hosting service: agentId, workspace, runner, HTTP/SSE
- [[AgentSpec]] — Wire schema for Backend ↔ Runner contract
- [[Layer_Architecture]] — L1–L5: Protocols, Runtime, Framework, Harness, Backend
- [[Design_Principles]] — 8 principles governing all design decisions
- [[FS_Memory_Plugin]] — Filesystem persistent memory via MEMORY.md + facts/
- [[Progressive_Skill_Plugin]] — Skill progressive loading via SKILL.md index + lazy fetch

### Entities
- [[my-agent-team_core]] — `@my-agent-team/core` — L1+L2 protocols and runtime
- [[my-agent-team_framework]] — `@my-agent-team/framework` — L3 assembly layer
- [[my-agent-team_harness-generic]] — `@my-agent-team/harness-generic` — L4 file-driven harness
- [[my-agent-team_adapter-anthropic]] — `@my-agent-team/adapter-anthropic` — Anthropic ChatModel implementation
- [[my-agent-team_plugin-fs-memory]] — `@my-agent-team/plugin-fs-memory` — FS memory plugin
- [[my-agent-team_plugin-progressive-skill]] — `@my-agent-team/plugin-progressive-skill` — Skill plugin
- [[my-agent-team_agent-spec]] — `@my-agent-team/agent-spec` — Wire schema package
- [[my-agent-team_backend]] — `apps/backend` — L5 backend service
- [[my-agent-team_runner-stdio]] — `@my-agent-team/runner-stdio` — stdio runner entry

### Summaries (13 source docs ingested)
- [[00-overview]] — Architecture overview, 4-layer model, milestones, design principles
- [[01-glossary]] — Unified terminology across all layers
- [[02-framework]] — L3 Framework: Agent, Plugin, Checkpointer, ContextManager, Logger
- [[03-plugin]] — Plugin extension mechanism: 4 hooks, HookContext, static tools
- [[04-checkpointer]] — Persistence, interrupt/resume, capability detection
- [[05-context-manager]] — Message shaping, token budget, sliding window, summarization
- [[06-plugin-fs-memory]] — FS memory plugin: MEMORY.md + facts/ + memory tools
- [[07-plugin-progressive-skill]] — Progressive skill plugin: SKILL.md index + skill_load
- [[08-harness]] — Harness concept: two forms, bootstrap protocol, backend boundary
- [[09-harness-generic]] — File-driven harness: workspace spec, builtin tools, templates
- [[10-harness-vs-framework]] — Framework vs Harness vs Backend: boundaries and anti-patterns
- [[11-backend]] — Backend: agentId, workspace materialization, runner transport, agent pool
- [[12-agent-spec]] — AgentSpec wire schema: zod, version evolution, cross-language future

## Open research questions

- Will harness-generic need hot-reload for workspace files mid-session?
- When does the project outgrow "small agent stack" and need distributed infra?
- Should AgentSpec switch to Protobuf for cross-language runners?

## Research gaps

Sources to ingest:
- [ ] Karpathy llm-wiki Gist — original inspiration for knowledge compilation pattern
- [ ] Anthropic Claude Code Skills documentation — reference for progressive-skill design

## Audit backlog

*(none — run `python3 scripts/audit_review.py <wiki-root> --open` to refresh)*

## Notes for the LLM

- Language: bilingual (Chinese technical terms with English code identifiers)
- Tone: technical, precise, Karpathy-style terse
- Depth: deep technical — architecture decisions with rationale
- Handling contradictions: state both, cite sources, add to Open Research Questions.
