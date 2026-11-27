---
title: Conversation & Context
description: Shared conversation_ledger facts, multi-member room routing, child dispatch rooms, per-agent AgentContext trees and branches, projection, and cli_session_ref continuity
tags: [conversation, context, history, backend]
---

# Conversation & Context

CrewDesk strictly separates **shared conversation facts** (`conversation_ledger`) from **per-agent semantic history** (`AgentContext`). Every surface (Web, Lark, Coding, Workflows) reads the same ledger, while each member agent in a conversation maintains its own isolated context tree, branch cursor, and native harness session reference.

## Authoritative files

- `apps/backend/src/features/conversation/service.ts` — `ConversationService` (`postMessage`, `undoMessages`, `forkConversation`, `replayFromMessage`, `compactConversation`, `dispatchRoom`, `startNewConversationForSurface`)
- `apps/backend/src/features/conversation/adapter-sqlite.ts` — Ledger persistence, search, bookmarks, and cascade deletes
- `apps/backend/src/features/conversation/ledger-codec.ts` — `LedgerKind` (`message | surface.control | undo`) and visibility rules
- `apps/backend/src/features/conversation/members.ts` — `createConversationMembers` (`list`, `add`, `remove`)
- `apps/backend/src/features/conversation/routing.ts` — `resolveTrigger()` derived from member count
- `apps/backend/src/features/conversation/session-model.ts` — `buildTurns()` read projection consumed by AHP and HTTP
- `apps/backend/src/features/conversation/http.ts` — `/api/conversations/*` and `/api/saved` routes
- `apps/backend/src/features/agent-context/domain.ts` — `AgentContextTree`, `AgentContextEntry`, `ContextBranch`
- `apps/backend/src/features/agent-context/adapter-sqlite.ts` — Tree/branch CRUD, `appendEntry` revision CAS, `forkBranch`
- `apps/backend/src/features/agent-context/projection.ts` — `projectAgentContext()` root-to-leaf folding
- `apps/backend/src/features/agent-run/continuation-ref.ts` — `resolveContinuationRef()` (`native_session_ref` vs scoped `cli_session_ref`)

## Conversation Ledger (`conversation_ledger`)

- **Ordering:** `seq` (SQLite auto-increment PK) is the sole total order within a conversation.
- **Entry kinds (`LedgerKind`):**
  - `message`: canonical `MessageRevision` (`@chengchenccc/message`).
  - `surface.control`: continuity markers emitted by `startNewConversationForSurface` (`{ newConversationId, requestedByRunId }`), idempotent per `requestedByRunId`.
  - `undo`: audit entry `{ undoneSeqs }` written when messages are soft-deleted (`undone = 1`).
- **Visibility filtering:** messages with `visibility === "internal"` are excluded from context sync (`enqueueAndAcquire`) and `history_*` product tools.
- **Author attribution:** human inputs from `"user"` or `"human:*"` carry no `authorAgentId`; agent-posted messages stamp `_meta.authorAgentId`, and `directToWorker: true` stamps `_meta.floorFor = { agentId, agentName }`.
- **Operations:**
  - `undoMessages(cid, count = 1)`: soft-deletes the latest `count` live `message` rows (`undone = 1`), appends an `undo` entry, and notifies AHP (`onMessagesUndone`) to invalidate cached state.
  - `forkConversation(cid, fromSeq)`: creates a new conversation (`origin: "fork"`, `forkSource`, `forkFromSeq`) and copies all non-undone ledger rows with `seq <= fromSeq`.
  - `replayFromMessage(cid, fromSeq, editedContent)`: forks at `fromSeq - 1`, then calls `postMessage`.
  - `setSaved(seq, saved)` / `listSaved()` (limit 200): projection-independent message bookmarks (`GET /api/saved`).
  - `searchLedger(keyword, limit = 20)`: tokenizes with `@chengchenccc/embedding`'s `needleSegments()` and AND-matches `LIKE %needle%`.
  - `deleteConversation(id)`: rejects with `409 ConflictError` if any active Run exists; recursively removes child rooms (`parent_conversation_id`), iteratively deletes `agent_context_entry` leaves (satisfying self-FK `RESTRICT`), clears `conversation_requirement`, and deletes the room.

## Multi-Member Rooms, Routing & Child Conversations

`conversation_member` is the authoritative roster (`1..N` agents per room; `conversation.agent_id` is the default front-desk agent). Creating a conversation immediately inserts `agentId` into `conversation_member`, and `POST /api/conversations` rejects creating a room directly with a `worker` agent unless `direct: true` (ADR 0049). `conversationMembers.remove()` refuses to remove the last remaining member (`MemberRuleError`).

Every `postMessage` resolves trigger targets in strict order:

1. **Count-derived routing (`routing.ts` → `resolveTrigger`):**
   - `0` members → `[]`.
   - `1` member → `[only]` if `addressedTo` is omitted or includes `only`; otherwise `[]`.
   - `>= 2` members → `members.filter(m => addressedTo?.includes(m))` (unaddressed messages are ledger-only unless caught by step 2).
2. **Room front-desk fallback (ADR 0066):** if `targets` is empty, `addressedTo === undefined`, `source === undefined`, and `conversation.agentId` is in `members`, routes to `[agentId]` so human messages are never silently dropped after a worker joins a room. Explicit `addressedTo: []` or observed `source` stays empty.
3. **Front-desk invariant (ADR 0049):** when `authorization === undefined` (human HTTP/surface input) and `directToWorker !== true`, any target where `isWorkerAgent(target)` is true is rerouted to the room's `agentId` (front desk).
4. **Ambient observe seam (ADR 0046):** if `targets` is empty, `source !== undefined`, `members.length === 1`, and content is string, evaluates `proactiveSvc.evaluate()`. An `act` match joins the target agent if needed, frames the input, sets `authorization = "ambient:<ruleId>"`, and triggers that agent.
5. **Ledger commit before enqueue:** persists the canonical `MessageRevision` to `conversation_ledger` first.
6. **Parked-ask interception:** for each target, `answerPendingTextAsk()` checks whether a text/allowOther `ask_question` is parked in this room; if so, consumes the pending action directly instead of enqueueing a new Run.
7. **Child dispatch rooms (ADR 0070):** `dispatchRoom({ parentConversationId, workerAgentId, reuse })` creates (or reuses the newest when `reuse: true`) a child conversation with `origin: "dispatch"`, `parentConversationId`, and copied `projectId`, keeping worker transcripts out of the human's main room. `listConversations()` returns origins `["user", "fork", "dispatch"]` and hides `"workflow"` rooms.

## Agent Context Trees, Branches & Projection

Each `(conversationId, agentId)` pair owns one `agent_context_tree` (legacy `agentId: null` rows are claimed on first member lookup) containing append-only `agent_context_entry` nodes (`ledger_message` or `summary`) linked via `parent_id`:

- **Default branch:** every tree has exactly one `is_default = 1` `agent_context_branch` (`idx_context_branch_default`), initialized at `revision = 1`, `ledger_cursor = 0`.
- **Optimistic concurrency (CAS):** every branch mutation (`enqueueAndAcquire`, `appendEntry`, `commitCompletedRun`, `acquireNextRun`) checks `expectedRevision` and bumps `revision + 1` inside a SQLite transaction, rejecting stale writers with `ContextRevisionConflictError`.
- **Incremental sync window:** during `enqueueAndAcquire`, only ledger rows with `seq > branch.ledgerCursor`, `undone = 0`, `kind = "message"`, and `visibility !== "internal"` are read, and at most the **latest 20** rows are appended as `ledger_message` entries.
- **Full branch projection (`projection.ts` → `projectAgentContext`):**
  1. Derives `conversationId` from `branch → tree` (never trusts a caller-supplied ID).
  2. Walks `parent_id` links from `leafEntryId` to root and reverses.
  3. Finds the latest `summary` entry (`ProductSummaryEntry`), replacing entries `0..coverIdx` with one internal user message carrying `summaryEntry.summary`, followed by any retained tail and post-summary `ledger_message` entries.
  4. Throws if `coversThroughEntryId` is not on the branch path or if a referenced `ledger_seq` is missing.

## Session Continuity (`native_session_ref` vs `cli_session_ref`)

Product Backend tracks **two distinct opaque session references** (`apps/backend/src/features/agent-run/continuation-ref.ts`):

| Reference | Where Stored | Written When | Purpose |
|---|---|---|---|
| `native_session_ref` | `agent_run.native_session_ref` | Immediately when ACP `session/new` or `session/load` succeeds (before prompting) | Crash/HITL resume of an interrupted Run so recovery never guesses which session file to reload. |
| `cli_session_ref` | `agent_context_branch.cli_session_ref` | At Run settlement (`settleOutcome`), prefixed as `<kind>/<harness>:<ref>` (or legacy `<kind>:<ref>`) | Multi-turn continuation across consecutive Runs on the same branch and harness. |

`resolveContinuationRef()` prefers `run.nativeSessionRef` first, then strips a matching `<kind>/<harness>:` prefix from `branch.cliSessionRef`. Foreign-backend or foreign-harness refs are **ignored** (never passed across harnesses), forcing a fresh session.

When no continuation ref resolves (first turn on a branch, or after switching harness), `buildRunInput()` flattens the projected branch history via `renderHistoryBridge()` (`## Conversation so far`) and prepends it to the first turn's user message. On subsequent turns with a valid continuation ref, the harness's own native session carries prior turns.

## Invariants

1. `conversation_ledger.seq` is the sole message ordering key in a conversation.
2. Context entries reference `ledger_seq`; they never duplicate canonical message bodies.
3. Removing a member from `conversation_member` removes routing only; its `agent_context_tree` is preserved.
4. `cli_session_ref` is opaque to Product Backend and strictly scoped to `(backendKind, harness)`; cross-harness session transfer is never attempted.
5. Branch mutations always serialize through `revision` CAS; no out-of-band update may advance `leaf_entry_id` or `ledger_cursor`.

## See also

- [Data Model](./data-model.md) — Exact table columns and indexes
- [Agent Run Execution](./agent-run-execution.md) — How `enqueueAndAcquire` and `commitCompletedRun` update context branches
- [Compaction](./compaction.md) — `oma` internal compaction vs backend `POST /api/conversations/:id/compact`
- [Team Coordination](./team-coordination.md) — Front-desk invariant, child rooms, and room dispatch
