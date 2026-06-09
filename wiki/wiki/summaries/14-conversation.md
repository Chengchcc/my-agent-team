---
title: "Summary: Conversation / Member"
type: summary
created: 2026-06-09
source: raw/articles/14-conversation.md
tags: [conversation, member, multi-agent, collaboration]
---

# 14 — Conversation / Member

Conversation upgrades `Thread` (an implicit single-agent `{id, messages}` line) into a **multi-agent thread container + conversation-level ledger**. Member makes "who is in the conversation" first-class: `AgentMember | HumanMember`. This is the abstraction base for advancing from "agent runtime" to "agent **team** runtime."

**Core mechanism**: **Broadcast visibility + @-triggered execution**. One `addressedTo` field encodes both dimensions: (1) all present agent members see every message (broadcast projection into each thread); (2) only addressedTo members trigger a run loop. "Y sees but doesn't respond" is a **mechanism**, not prompt engineering.

**Five first-principle drivers**: (1) thread implicitly binds to a single agent; (2) agents need to know each other exists; (3) human is a first-class member, not a "tool user"; (4) visibility and execution must be decoupled; (5) execution layer (M9) should not bear collaboration semantics — overlay, don't invade.

**Two mechanical safety valves**: (1) Single active run per conversation (serial execution, 409 on conflict); (2) `maxConsecutiveAgentHops` (default 8) — mechanical counter, human message resets hopCount=0. Guarantees termination without semantic judgment.

**Ledger vs thread.messages**: Conversation ledger is the **only fact source** (append-only, unified shape). thread.messages are **broadcast-derived materialized views** (via checkpointer). This keeps M9 recovery path zero-change — agent subprocess only knows checkpointer, never sees ledger.

**Degeneration invariant**: 1 human + 1 agent conversation = old single-thread M9 model. Conversation is a strict superset — zero regression.
