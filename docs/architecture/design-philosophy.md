---
title: Design Philosophy
description: Core architectural judgment criteria for CrewDesk — 8 principles, pre-implementation checks, concrete anti-patterns, red flags, and decision order
tags: [conventions, rules]
---

# Design Philosophy

> **Language:** **English (canonical)** · [简体中文](./design-philosophy.zh-CN.md)

This document defines the architectural decision criteria for writing code, reviewing PRs, and updating specs in CrewDesk. Its single thesis is:

> **Keep the domain mental model small and stable. Implementation mechanisms may be sophisticated, but they must never leak upward into domain concepts.**

Complex systems do not become clearer by inventing more nouns. Before introducing any new type, table, event, or abstraction, answer: *Which existing domain object owns this fact? Is the new noun business vocabulary or leaked plumbing? Will the next engineer (or coding agent) have to learn an extra layer just to trace a user action?*

## The 8 Principles

1. **Unify semantics before choosing mechanisms.** Start from what a fact means in the shared world of humans and agents, not from tables, queues, streams, or projections.
   - *Wrong:* Define `LedgerMessage` for storage, `RunStreamMessage` for transport, and `UiMessage` for rendering.
   - *Right:* `Message` is the single domain entity; storage rows, AHP envelopes, UI render state, and Lark delivery records wrap or reference it.
2. **One semantic object, one ontology.** If two types answer the same "who said what when", share completion/failure/waiting states, collapse into one row in UI, and differ only by module location, they must share one canonical type.
3. **Hide mechanisms beneath business flow.** Append-only logs, projections, delivery ledgers, and retry queues belong in the implementation layer. The primary narrative is *"Run produces Message → Conversation stores Message → Surface renders Message"*, not *"RunEvent enters telemetry → projection writes LedgerEntry → watcher parses JSON"*.
4. **Hard boundaries, few concepts.** Keep domain nouns minimal and stable (`Agent`, `Conversation`, `Message`, `Agent Run`, `Requirement`, `Project`, `Workflow`, `Artifact`, `Wiki`, `Proposal`). Mechanism nouns (`Ledger`, `Projection`, `Queue`, `Delivery`, `Lock`, `Cache`, `Index`) stay scoped to implementation internals.
5. **Names are architecture.** Naming a mechanism as a domain entity permanently bends future code around the wrong abstraction. Prefer *Message in conversation storage* and *message delivery state* over `LedgerMessage` and `LarkMessage`.
6. **Projections are an implementation technique, not the storyline.** If a newcomer must understand projection mechanics before understanding what a user sees on screen, the mechanism has leaked upward.
7. **Control loops require a unified internal model.** Under the Good Regulator Theorem, an agent control system fails when Backend, Child Process, Web, and Lark hold drifting models of a message or run state (one layer considers a turn done while another stays stuck waiting, or duplicates a reply).
8. **Do not mistake module boundaries for domain boundaries.** Conway's Law reproduces itself inside a monorepo as `backend/*`, `web/*`, and `lark-bot/*` inventing three parallel schemas for one entity. Always ask: *Is this a domain boundary or merely a package boundary?*

## Pre-Implementation Checklist

Run three checks before writing code:

- **Concept check:** Did I introduce a new noun? Could an existing domain object express it? Does it exist solely because data crossed a process, table, or surface boundary? If yes, do not add it.
- **Semantic check:** What owns its identity, lifecycle, and terminal state? Is it user-visible, model-visible, auditable, or deliverable? If all answers match an existing entity, reuse that entity.
- **Mechanism check:** Did storage or wire names leak into business APIs? Does a surface inspect internal Run telemetry events to deduce user-visible state? Is delivery or UI render state mixed into canonical message content? If yes, push the mechanism back down.

## Concrete Contrast Examples

| Area | Anti-pattern | CrewDesk pattern |
|---|---|---|
| **Message flow** | `RunEventMessage → LedgerMessage → UiMessage → LarkMessage` (4 drifting schemas) | One canonical `Message` (`@chengchenccc/message`); each layer attaches only its outer envelope (storage seq, AHP `_meta`, Lark `message_delivery` row). |
| **Streaming output** | Every delta chunk creates a message; each surface manages ad-hoc drafts. | Ephemeral deltas stream over `/ws/ahp`; canonical `Message` commits once atomically at `BackendRunOutcome` and folds onto the same turn. |
| **Audit vs user facts** | Surfaces consume raw `agent_run_event` telemetry to reconstruct chat history. | `agent_run.terminal_result`, `agent_run_event`, and `product_tool_call` serve audit/debugging; `conversation_ledger` is the sole chat truth. |
| **Delivery state** | Creating a `LarkMessage` domain type to track Feishu send retries. | `Message` stays content-only; `apps/lark-bot` tracks delivery state in its local `message_delivery` table keyed by `(conversation_id, message_id, lark_chat_id)`. |
| **HITL waiting state** | Keeping approval prompts only in ephemeral memory streams (lost on refresh/restart). | Durable `pending_action` rows persist before surfacing (ADR 0038/0039) and drive both `/ws/ahp` cards and `GET /api/attention`. |
| **Agent config edits** | Letting agent MCP tools directly overwrite `agent.yml`, `project`, or `*.workflow.json`. | MCP tools emit durable `proposal` rows; humans review diffs in `ProposalCard` and explicitly adopt/save (ADR 0081). |

## Red Flags

Stop and redesign if a PR exhibits any of these signals:

- Introduces 3+ near-synonymous nouns in a single change.
- Requires cross-referencing 2–3 unrelated tables or streams to deduce one user-visible state.
- Forces Web or Lark to branch on private harness/run internal event names.
- Generates IDs for the same logical message using different rules in different layers.
- Encodes terminal state only via side-channel events rather than on the entity itself.
- Puts storage/transport prefixes (`LedgerXxx`, `StreamXxx`, `UiXxx`) on domain types.
- Fixing one message bug requires patching 3–4 duplicate parsers across packages.

## Allowed vs Disallowed Complexity

- **Allowed (behind hard boundaries):** append-only ledgers for replay, telemetry whitelists for diagnostics, surface-local delivery tables for at-least-once retries, read-model indexes (`artifact`, `EntityLabelResolver`), caches, and per-worktree mutexes — *provided none of them redefine core domain entities*.
- **Disallowed:** per-store message models, per-surface lifecycle definitions, multiple layers deciding when a turn ends, duplicate normalizers/parsers per package, or documentation that explains storage plumbing before user/domain semantics.

## Decision Order

Always design top-down in this exact sequence — never bottom-up from tables, endpoints, or UI widgets:

```text
1. What is the domain object?
2. What are its invariants?
3. Where does its lifecycle terminate?
4. Who reads it?
5. Who is allowed to write it?
6. Which storage mechanism persists it?
7. Which surfaces deliver or render it?
8. Which implementation details must remain hidden?
```

## Three-Line Summary

```text
Unify ontology; never duplicate semantics.
Expose domain; hide mechanism.
Keep boundaries hard and concepts few.
```

## See also

- [E2E Contract Rules](./e2e-contract-rules.md) — Mechanical enforcement of single-ontology across processes
- [DB Type-Safe Rules](./db-typesafe-rules.md) — Mechanical enforcement of single-ontology from SQLite to HTTP
- [System Overview](./system-overview.md) — How these principles shape CrewDesk's runtime layers
- [Operations & Gateway](./operations-and-gateway.md) — Composition-root DI and startup/shutdown boundaries
