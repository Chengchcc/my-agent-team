---
title: "Conversation"
type: concept
created: 2026-06-09
sources:
  - raw/articles/14-conversation.md
  - raw/articles/00-vision.md
  - raw/articles/13-event-log.md
tags: [conversation, member, multi-agent, L5, collaboration]
---

# Conversation

A **multi-agent thread container + conversation-level ledger** that upgrades the single-agent `{threadId, messages}` model into a multi-member collaboration space. Defined at L5; does not invade L4 and below.

## Core abstraction

| Abstraction | Meaning | Relationship |
|-------------|---------|-------------|
| **Conversation** | Container aggregating multiple agent threads + conversation ledger (fact source) | Replaces single-thread model; degenerates to M9 thread for 1-agent case |
| **Member** | First-class roster entry: `AgentMember \| HumanMember` | Human and agent are equal members |
| **Ledger** | Sole fact source for conversation events: messages + membership events, unified shape, monotonic seq | Same spirit as [[EventLog]] but at **conversation semantic layer** |
| **thread.messages** | Per-agent execution-state message sequence | **Broadcast-derived** materialized view from ledger, not fact source |

## Core mechanism: broadcast visibility + @-triggered execution

```
Any member sends { sender, addressedTo[], content }
  → ① append to ledger (fact source)
  → ② broadcast to ALL present agent members' thread.messages (visibility)
  → ③ ONLY addressedTo members fork a run (execution)
```

`addressedTo` encodes **two orthogonal dimensions** in one field:
- **Visibility (②)**: broadcast to all — everyone sees
- **Execution (③)**: trigger only addressedTo — others don't run

"User talks to X, Y sees but doesn't respond" = Y gets the message in its thread but isn't triggered. The **mechanism** guarantees non-response, not prompt engineering.

## Two safety valves

Multi-agent mutual @ creates infinite loop risk. Two **purely mechanical** valves (no semantic judgment):

| Valve | Guards against | Mechanism |
|-------|---------------|-----------|
| **Single active run per conversation** | Concurrent explosion | 409 on conflict; agents always serial |
| **`maxConsecutiveAgentHops`** (default 8) | Infinite serial ping-pong | Counter: human message → reset; agent→agent → increment; overflow → reject + system message |

Human in `mention` mode is the **natural gate** — only addressed members run. Both valves together guarantee: without external (human) continuous push, agent group necessarily stops in finite steps.

## Ledger vs EventLog

| | conversation ledger | [[EventLog\|event_log]] |
|---|---|---|
| **Dimension** | Conversation semantics (who said what, who joined/left) | Run execution (AgentEvent stream from one loop) |
| **Granularity** | One entry = one message/member event | One record = one execution event |
| **Relationship** | One ledger message @agent → triggers run → run produces many event_log records | Reverse: event_log records belong to a (conversationId, agentMemberId) thread |

SSE projection: conversation-level uses ledger's seq; run-level uses event_log's seq. Two layered streams, not interleaved.

## Degeneration invariant

1 human + 1 agent conversation **exactly degenerates** to an M9 single-thread model. Conversation is a **strict superset** — M9 execution, persistence, and recovery paths are zero-change.

## Invariants

- Conversation is a thread container, never breaks degeneration
- M9 execution layer zero-invasion — EventLog four iron laws, run/attempt, SSE projection, cancel/resume/checkpointer all unchanged
- Visibility broadcast + execution by @ — non-response is mechanism, not prompt
- Ledger is sole conversation fact source; thread.messages are broadcast-derived (materialized via checkpointer)
- Human/agent/system messages are isomorphic — same ledger record, same pipeline
- Collaboration semantics **stop at backend layer** — framework/harness/runner never see ledger/conversation
