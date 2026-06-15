# @my-agent-team/conversation

> **Layer:** L1 Protocols (domain types) &nbsp;|&nbsp; **Dependencies:** `zod` only

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L6  Surfaces     web / cli / lark-bot    │
│ L5  Backend ─────┐                       │
│                  │ uses Conversation,    │
│                  │ Member, LedgerEntry   │
├──────────────────┼───────────────────────┤
│ L1  Protocols    │  ◄── HERE             │
└──────────────────┼───────────────────────┘
                   │
        Defines the multi-agent
        conversation domain model
```

## What problem it solves

Multi-agent conversations need a shared model: who's in the conversation, how messages are addressed, how mentions trigger other agents. This package defines pure Zod schemas and helpers — no runtime dependencies beyond `zod`. The backend uses these types for its conversation CRUD and message routing.

## Domain model

```
┌──────────────┐     ┌──────────────────┐
│ Conversation │────→│ Member[]         │
│ triggerMode  │     │ AgentMember      │
│ (mention|all)│     │ HumanMember      │
└──────────────┘     └──────────────────┘
                             │
                     ┌───────▼───────┐
                     │  LedgerEntry  │
                     │  seq          │
                     │  senderMemberId│
                     │  addressedTo[] │
                     │  kind          │
                     │  content       │
                     │  ts            │
                     └───────────────┘
```

## Message projection

`projectForMember()` converts a raw ledger entry into an LLM-visible message, handling:

- **System messages** → system prompt content on first turn
- **Self messages** → marked as assistant's own output
- **Other-agent messages** → prefixed with `@agent-name:`
- **Human messages** → shown as user role
- **@-mentions** → routed to the addressed member

## Key exports

| Export | What | Why |
|--------|------|-----|
| `Conversation` | Zod schema | Conversation config with trigger mode |
| `Member` / `AgentMember` / `HumanMember` | Zod schemas | Participant types |
| `LedgerEntry` | Zod schema | Append-only message record with addressing |
| `projectForMember()` | `(entry, memberId) → Message` | Convert ledger entry to LLM-visible format |
| `resolveTriggerTargets()` | `(addressedTo, members) → AgentMember[]` | Resolve @-mentions to agent IDs |
| `assertAgentMember()` | Validation helper | Ensure a member is an agent |

## Dependencies

```
conversation (this package)
  ↑ depends on: zod
  ↑ depended on by: apps/backend
```
