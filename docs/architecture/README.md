---
title: Architecture Index
description: Entry point for CrewDesk's current-state architecture docs — task-based reading router, flat subsystem map, canonical glossary, global invariants, and wiki rules
tags: [index, overview, conventions]
---

# Architecture

> **Language:** **English (canonical)** · [简体中文入口](./README.zh-CN.md) (Chinese mirrors available for [Index](./README.zh-CN.md), [System Overview](./system-overview.zh-CN.md), and [Design Philosophy](./design-philosophy.zh-CN.md); all deep subsystem specs are English single-source).

This directory is the **current-state** technical specification of CrewDesk (`my-agent-team`). Every page documents what the code does **today**, anchored to verified repository paths, concrete schemas, defaults, and invariants. CI enforces link integrity, frontmatter presence, vocabulary hygiene, and code-path existence via `bun run audit:docs` (`scripts/audit-docs.ts`).

- **Future work / unbuilt features** live in [`../roadmap.md`](../roadmap.md).
- **Historical rationale & superseded decisions** live in [`../adr/README.md`](../adr/README.md).
- **Local setup & day-to-day commands** live in [`../guides/development.md`](../guides/development.md).

## Task-Based Router

Find the exact pages to read before editing a subsystem:

| If you are changing... | Read in order |
|---|---|
| Understanding the system end to end | [System Overview](./system-overview.md) → [Data Model](./data-model.md) → [Agent Run Execution](./agent-run-execution.md) → [Team Coordination](./team-coordination.md) |
| Architectural rules before any PR | [Design Philosophy](./design-philosophy.md) → [E2E Contract Rules](./e2e-contract-rules.md) → [DB Type-Safe Rules](./db-typesafe-rules.md) |
| SQLite tables, columns, or migrations | [DB Type-Safe Rules](./db-typesafe-rules.md) → [Data Model](./data-model.md) |
| Messages, ledger, context branches, or sessions | [Conversation & Context](./conversation-and-context.md) → [Agent Run Execution](./agent-run-execution.md) → [Data Model](./data-model.md) |
| Run lifecycle, queue, HITL, or crash recovery | [Agent Run Execution](./agent-run-execution.md) → [ACP Backend Contract](./acp-backend-contract.md) → [Data Model](./data-model.md) |
| ACP harnesses (`oma`, `claude`, `pi`, `omp`) | [ACP Backend Contract](./acp-backend-contract.md) → [Workspaces & Projects](./workspaces-and-projects.md) → [Oma Runtime](./oma-runtime.md) |
| PA + Worker dispatch, product MCP, or proposals | [Team Coordination](./team-coordination.md) → [Agent Run Execution](./agent-run-execution.md) → [Proactive & Knowledge](./proactive-and-knowledge.md) |
| Requirements, wiki, recall, reminders, or attention debt | [Proactive & Knowledge](./proactive-and-knowledge.md) → [Data Model](./data-model.md) → [Team Coordination](./team-coordination.md) |
| Agent workspaces, MCP catalog, worktrees, or Coding PTY | [Workspaces & Projects](./workspaces-and-projects.md) → [Security Model](./security-model.md) → [Web Surface](./web-surface.md) |
| Declarative workflows, triggers, or `artifacts://` | [Workflow Engine](./workflow.md) → [Data Model](./data-model.md) → [Workspaces & Projects](./workspaces-and-projects.md) |
| Skills, skill packs, Oma plugins, or permission gates | [Skills & Plugins](./skills-and-plugins.md) → [Oma Runtime](./oma-runtime.md) → [Security Model](./security-model.md) |
| `oma` CLI, agent loop, tools, delegation, or TUI | [Oma Runtime](./oma-runtime.md) → [Skills & Plugins](./skills-and-plugins.md) → [Compaction](./compaction.md) |
| LLM providers, `models.yml`, or model catalogs | [Models & Providers](./models-and-providers.md) → [ACP Backend Contract](./acp-backend-contract.md) → [Oma Runtime](./oma-runtime.md) |
| Context compaction or tool-result pruning | [Compaction](./compaction.md) → [Conversation & Context](./conversation-and-context.md) → [Oma Runtime](./oma-runtime.md) |
| AHP WebSocket contract or cross-surface linkage | [AHP Surface Contract](./ahp-surface-contract.md) → [E2E Contract Rules](./e2e-contract-rules.md) |
| Web console (`apps/web`), BFF, i18n, or Chat UI | [Web Surface](./web-surface.md) → [AHP Surface Contract](./ahp-surface-contract.md) → [E2E Contract Rules](./e2e-contract-rules.md) |
| Lark/Feishu bot (`apps/lark-bot`), cards, or setup | [Lark Surface](./lark-surface.md) → [AHP Surface Contract](./ahp-surface-contract.md) → [Proactive & Knowledge](./proactive-and-knowledge.md) |
| Auth, path jail, SSRF, bash sandbox, or open debt | [Security Model](./security-model.md) → [Workspaces & Projects](./workspaces-and-projects.md) |
| DI bootstrap, `oma gateway`, systemd, or incidents | [Operations & Gateway](./operations-and-gateway.md) → [Security Model](./security-model.md) |

## Document Map

### Entry & Architectural Rules
- [System Overview](./system-overview.md) ([中文](./system-overview.zh-CN.md)) — PA + Worker topology, ownership boundaries, single execution pipeline, failure principles
- [Design Philosophy](./design-philosophy.md) ([中文](./design-philosophy.zh-CN.md)) — 8 principles, concept/semantic/mechanism checks, red flags, decision order
- [E2E Contract Rules](./e2e-contract-rules.md) — Cross-process single-source type rules and automated CI gates (`audit:contracts`, `audit:workspace`, `audit:ui`)
- [DB Type-Safe Rules](./db-typesafe-rules.md) — `schema.ts` → `$inferSelect`/`$inferInsert` → `drizzle-zod` → service → HTTP chain and Drizzle migration rules

### Backend Control Plane & Coordination
- [Data Model](./data-model.md) — All 30 `backend.db` SQLite tables, partial unique indexes, idempotency keys, atomic transactions, and off-DB files
- [Conversation & Context](./conversation-and-context.md) — `conversation_ledger`, 1:1 room routing, child rooms, `AgentContext` trees/branches, projection, `cli_session_ref`
- [Agent Run Execution](./agent-run-execution.md) — `enqueueAndAcquire`, 9-stage dispatch machine, watchdogs, durable HITL (`pending_action`), terminal commit, `retry-commit`, crash recovery
- [ACP Backend Contract](./acp-backend-contract.md) — Single `acp` backend boundary, 4 harnesses (`oma`/`claude`/`pi`/`omp`), stdio JSON-RPC lifecycle, event mapping, `HeldPermission`
- [Team Coordination](./team-coordination.md) — PA + Worker boundaries, Product Tools MCP (32+3+2 tools), dispatch facets & pool recall, duplex loop, request ownership, delivery gate, proposals
- [Proactive & Knowledge](./proactive-and-knowledge.md) — Reminders, requirements, Git-backed Wiki, unified recall & cross-process memory, attention debt

### Workspaces, Workflows & Extensibility
- [Workspaces & Projects](./workspaces-and-projects.md) — Agent workspace layout, Workspace Bridge, encrypted MCP file catalog, Git mirrors & worktrees, safe `project_push`, Coding PTY terminals
- [Workflow Engine](./workflow.md) — Pure DSL (`packages/workflow`), 5 node types, 13-op JSON-Logic, parallel waves, rework & `#budget` gates, cron/webhook triggers, `artifacts://`
- [Skills & Plugins](./skills-and-plugins.md) — Role-scoped builtin skills, Skill Pack install/sync state machine, progressive skill discovery, Oma plugin trust matrix, HITL permission modes & pattern rules

### Oma Runtime & Models
- [Oma Runtime](./oma-runtime.md) — `apps/oh-my-agent` 4 modes (`print`/`json`/`acp`/`tui`), `setup`/`doctor`/`--worktree`, 3-tier settings, dynamic USD budget cap, `createOmaSession()`, native tools, delegation & `orchestrate`, shadow checkpoints, autonomous memory, TUI layering, goals/loops/plans
- [Models & Providers](./models-and-providers.md) — `@chengchenccc/ai` 3 wire protocols, `BUILTIN_CATALOG` vs `$OMA_HOME/models.yml`, credential resolution, aliases, live catalog probing
- [Compaction](./compaction.md) — `oma` 4-trigger compaction, CJK-aware cut points, 6-section + deterministic state blocks, opt-in tool pruning, backend `/compact`

### Surfaces
- [AHP Surface Contract](./ahp-surface-contract.md) — `@chengchenccc/ahp-client` WS transport, ticket auth, `ahp-chat:/` snapshot & action streams, `_meta` extensions, `EntityLabelResolver`
- [Web Surface](./web-surface.md) — Next.js 15 console, BFF proxy & `maw_session`, Eden Treaty, navigation IA, English-source i18n skin, split inspector, PTY terminal, E2E message flow
- [Lark Surface](./lark-surface.md) — `@larksuite/channel` inbound & doc comments, 3-layer access gate, 10 local SQLite tables, CardKit streaming run cards, systemd supervision, E2E flow

### Security, Operations & Archives
- [Security Model](./security-model.md) — Single-operator threat model, auth, path jail, URL guard, OS sandboxes (`bwrap`/`sandbox-exec`), allowlist proxy, open security debt register
- [Operations & Gateway](./operations-and-gateway.md) — Backend DI composition root, `oma gateway` packaging/lifecycle/upgrade, systemd units, `OMA_DEBUG=1`, troubleshooting runbook
- [Backend Kinds Gate 0 Snapshot](./backend-kinds-gate0.md) — Point-in-time (2026-08-12/13) CLI protocol measurement archive (not a current contract)

## Canonical Glossary

Terms across the codebase follow these definitions:

| Term | Definition |
|---|---|
| **Agent** | A team member whose identity (`SOUL.md`/`USER.md`), config (`agent.yml`), skills, and memory live as files in its workspace; `role` is `"front"` (PA) or `"worker"`. |
| **PA (Front Desk)** | Human-facing agent (`role !== "worker"`) that manages attention, tracks requirements, dispatches workers, and maintains the Git Wiki. Physically stripped of code/shell tools (`FRONT_DESK_DISABLED_TOOLS`). |
| **Worker** | Specialist agent (`role === "worker"`) executing in isolated child conversations and requirement/project worktrees across any of the 4 ACP harnesses. |
| **Conversation** | A 1:1 room backed by `conversation_ledger` and owned by `conversation.agent_id`. Root rooms face humans; child rooms (`parent_conversation_id`) hold dispatched worker runs. |
| **Message** | Canonical domain turn object (`@chengchenccc/message`) shared across ledger, context projection, AHP, and surfaces. |
| **Agent Context** | Per-`(conversation, agent)` append-only tree (`agent_context_tree`/`entry`/`branch`) referencing ledger messages and product summaries. |
| **Agent Run** | Unique product execution identity (`agent_run`) pinned to a context branch; every Run spawns one ephemeral ACP child process. |
| **ACP Harness** | One of four CLI engines (`oma`, `claude`, `pi`, `omp`) registered in `ACP_AGENTS` and driven by the single `acp` backend client. |
| **Product Tool** | Backend-owned capability exposed over MCP (`product-tools`, `agent-config`, `workflow`) with a per-run bearer token revoked at settlement. |
| **Requirement** | Stable work goal (`requirement`) tracked across conversations and runs; owns project checkouts (`workspace`, `requirement_workspace`). |
| **Proposal** | Unapplied change (`proposal`) emitted by agent MCP tools (`agent_config`, `workflow_definition`, `project_creation`, `project_update`) requiring explicit human adoption. |
| **Wiki** | Product-level Git-backed Markdown knowledge base (`<dataDir>/wiki`) with 5 spaces, CAS revisions, and source provenance; replaced legacy knowledge packs (ADR 0078). |
| **Workflow** | Declarative DAG (`*.workflow.json`, `packages/workflow`) of `start`/`end`/`agent`/`script`/`human` nodes with JSON-Logic routing, parallel waves, rework budgets, and cron/webhook triggers. |
| **Artifact** | Typed file stored on disk under `<dataDir>/artifacts` and indexed in SQLite (`artifact`), addressed via `artifacts://<folder>/<filename>`. |
| **AHP** | Agent Host Protocol over `/ws/ahp`: the single live state-mirror transport between Product Backend and surfaces (Web, Lark). |
| **Oma** | In-repo CLI and agent runtime (`apps/oh-my-agent`) supporting `print`, `json`, `acp`, and `tui` modes. |

## Global Invariants

1. **Backend is the single source of truth.** Web, Lark, and Coding terminals render backend facts (`conversation_ledger`, `agent_run`, `pending_action`, `requirement`, `wiki`); surfaces hold only local delivery/UI state.
2. **One Run = one ephemeral ACP child.** There are no long-lived cross-run agent daemons; multi-turn continuity relies on opaque `cli_session_ref` / `native_session_ref` tokens resumed by each harness.
3. **Single active Run per context branch.** Enforced by both `enqueueAndAcquire` and partial unique index `idx_agent_run_active_branch`.
4. **Streaming is transient; terminal commit is atomic.** Deltas never enter `conversation_ledger`; `commitCompletedRun` commits ledger rows, context entries, branch CAS, and run status in one SQLite transaction keyed by `(agent_run_id, message_index)`.
5. **Fail-closed HITL and hard role isolation.** Approvals and asks persist in `pending_action` before surfacing and time out to deny; front-desk tools are stripped in code; `project_push` only targets `agent/<runId>`; proposals never auto-apply.
6. **Subprocess internals stay private.** Product Backend depends only on the 5-method `AgentBackend` contract, never on `oma`'s internal loop, compaction, or todo files.

## Editing Rules for This Directory

- **State facts as of `HEAD` only.** Put rationale and migration history in `docs/adr/`, future plans in `docs/roadmap.md`.
- **Single source of truth.** State each subsystem's contracts once on its owning page; link everywhere else. Keep Chinese mirrors strictly limited to the three entry pages (`README.zh-CN.md`, `system-overview.zh-CN.md`, `design-philosophy.zh-CN.md`).
- **Anchor to real code.** Every page starts with YAML frontmatter (`title`, `description`, `tags`) and an `## Authoritative files` list. Run `bun run audit:docs` before committing.
