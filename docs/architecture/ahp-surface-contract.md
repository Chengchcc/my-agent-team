---
title: AHP Surface Contract
description: Agent Host Protocol (AHP) live state-mirror contract — @chengchenccc/ahp-client WS transport, ticket auth & BFF host rewrite, 3 channels, snapshot vs action streams, _meta extensions, and ADR 0082 EntityLabelResolver
tags: [surfaces, ahp, protocol, websocket]
---

# AHP Surface Contract

Agent Host Protocol (**AHP**, ADRs 0040, 0069, 0082) is the **sole** real-time state-mirror transport between Product Backend and surfaces (Web and Lark). Backend has no active SSE endpoints left; every live conversation, streaming delta, tool activity, todo snapshot, and HITL card travels over `/ws/ahp` using `@microsoft/agent-host-protocol` state and action types.

## Authoritative files

- `packages/ahp-client/src/transport.ts` & `client.ts` & `uris.ts` — WebSocket transport wrapper, `AhpClientLike`, URI builders (`chatUri`, `sessionUri`, `AHP_ROOT_URI`)
- `packages/api-contract/src/sse.ts` & `index.ts` — Shared `OmaTodoItem`, `DEDICATED_EVENT_TOOLS`, `hasDedicatedEvent()`, `AGENT_DRAFT_ID`
- `apps/backend/src/features/ahp/http.ts` — `POST /api/ahp/ws-ticket`, `WS /ws/ahp?ticket=`
- `apps/backend/src/features/ahp/protocol.ts` — `createAhpServer()`, 3 channels, replay ring buffer (`512`), serialization gate, `invalidate()`
- `apps/backend/src/features/ahp/state-source.ts` — Read-only DB projection (`root`, `session`, `chat`) and `_meta` attachment
- `apps/backend/src/features/ahp/chat-writer.ts` & `run-events.ts` — Translating live `BackendEvent`s into AHP `chat/*` actions and folding committed turns
- `apps/backend/src/infra/ws-ticket.ts` — One-time 256-bit WebSocket ticket registry (`60 s` TTL)
- `apps/backend/src/infra/entity-labels.ts` — `createEntityLabelResolver()` batch human-label lookup (ADR 0082)
- `apps/web/src/lib/bff.ts` — `rewriteWsTicket()` (`AHP_PUBLIC_WS_BASE` & browser-host rewriting)

## Transport, Auth & Host Rewriting

1. **Ticket minting (`POST /api/ahp/ws-ticket`):** authenticated via `x-auth-token` (or Web BFF cookie). Mints a 32-byte hex single-use ticket (`DEFAULT_WS_TICKET_TTL_MS = 60_000`) and returns `{ ticket, wsBase }`.
2. **BFF host rewriting (`apps/web/src/lib/bff.ts` → `rewriteWsTicket`, ADR 0069):**
   - Intercepts both `POST /api/bff/api/ahp/ws-ticket` and `POST /api/bff/api/coding/ws-ticket` (`Cache-Control: no-store`).
   - Rewrites `wsBase` to `${proto === "https:" ? "wss" : "ws"}://${pageHost}:${backendPort}` so remote browsers connect to the page's host instead of `127.0.0.1`. If `AHP_PUBLIC_WS_BASE` is set, it overrides `ahp/ws-ticket` verbatim.
3. **WebSocket upgrade (`WS /ws/ahp?ticket=<hex>`):** exempt from `x-auth-token` because browsers cannot send custom WS headers; validates and consumes the one-time ticket (invalid/expired/reused closes with **`4001 "invalid ticket"`**). Connection state lives on `ws.data.ahp`.
4. **Client transport (`packages/ahp-client/src/transport.ts`):** buffers `send()` frames during handshake until `open`, handles `string` / `Uint8Array` / `ArrayBuffer` / `Blob`, and tracks `maxQueueDepth` on its uncapped `FrameQueue` (exposed on Web as `window.__ahpQueueDepth`).

## Channels, Snapshots, Actions & `invalidate()`

`createAhpServer()` (`protocol.ts`) serves **3 URI prefixes** over JSON-RPC 2.0 (`initialize`, `subscribe`, `reconnect`, `unsubscribe`, `ping`):
- `ahp-root://` — Global surface summary
- `ahp-session:/<conversationId>` — Per-conversation `SessionStatus` bitmask (`IDLE = 1`, `ERROR = 2`, `IN_PROGRESS = 8`, `INPUT_NEEDED = 24`)
- `ahp-chat:/<conversationId>` — Full conversation turns, active turn, parts, tool calls, and input requests

**State-mirror mechanics:**
- **Lazy seeding + serialization invariant:** a Promise-chain gate (`serialized`) serializes `initialize`, `subscribe`, `reconnect`, and `dispatch` so no action can land in the async gap between reading a snapshot and registering a subscriber.
- **Ring-buffer reconnect:** `dispatch(uri, action)` increments `serverSeq`, reduces state via upstream `rootReducer`/`sessionReducer`/`chatReducer`, appends to a `512`-entry replay buffer, and notifies subscribers (`method: "action"`). `reconnect` replays missed actions if contiguous (`missed[0].serverSeq === lastSeen + 1`), else falls back to a full `snapshot`.
- **DB-only invalidation (`invalidate(uri)`):** mutations with no AHP action (`todo_update`, `undo`, `commit_failed`) evict the cached state from `states`. Surfaces call `client.subscribe(uri)` (e.g., on `chat/toolCallComplete`) to pull a fresh snapshot containing updated `_meta.todos`.
- **Unavailable resources** throw `ChannelUnavailableError` (`-32008 NOT_FOUND` / `-32602 INVALID_PARAMS`); the server never caches an empty placeholder.

## Product `_meta` Extensions (`state-source.ts`, `chat-writer.ts`)

Product-specific facts ride upstream AHP envelopes via `_meta` without inventing parallel wire types:

| AHP Node | `_meta` Fields | Meaning |
|---|---|---|
| `ChatState._meta` | `{ todos }` | Active turn's latest `OmaTodoItem[]` snapshot. |
| `Turn.message._meta` | `{ messageId?, seq?, undone?, anchor?, floorFor?, dispatchTo?, authorAgentId? }` | Canonical ledger identity, artifact comment anchor, `directToWorker` badge, child dispatch link, and speaker ID. |
| `ResponsePart._meta` | `{ messageId?, seq?, undone?, authorAgentId? }` | Prevents cross-agent voice misattribution (Lark filters by `authorAgentId === selfAgentId`). |
| `SystemNotificationResponsePart._meta` | `{ newConversationId, requestedByRunId }` | Continuity turn (`continuity:<seq>`) emitted by `startNewConversationForSurface`. |
| `InputRequestResponsePart.request._meta` | `{ productRequest }` | Full durable `pending_action` payload driving approval & ask cards. |

**Writer rules (`chat-writer.ts`):**
- Per-run async queue guarantees `chat/turnStarted` precedes `chat/responsePart`, `chat/delta`, and `chat/reasoning`.
- Tool calls emit `chat/toolCallStart` + immediate `chat/toolCallReady` (`confirmed: "not-needed"`) because upstream `chatReducer` ignores `chat/toolCallComplete` while still `streaming`.
- Tool outputs carrying images (max 4, `png/jpeg/gif/webp`) persist via `saveImage` and emit `contentRef` parts (`{ uri, contentType, sizeHint }`).
- On settlement, `foldCommittedTurn(runId, durationMs)` replaces the live preview with a fresh DB projection (`chat/turnStarted` + canonical parts + `chat/turnComplete` or `chat/turnCancelled`).

## Surface Ownership Boundaries

| Owned by Every Surface | Never Owned by Any Surface |
|---|---|
| Input capture, slash-command UI, and rendering | Canonical conversation truth (`conversation_ledger`) |
| Local identity/channel bindings & delivery deduplication | Run scheduling, retries, or terminal commit authority |
| Transient UI state (scroll, filters, card visual layout) | Permission policy evaluation or product tool execution |

## Cross-Surface Linkage & Human Labels (`entity-labels.ts`, ADR 0082)

- `createEntityLabelResolver(db, { workflowDir })` resolves human-readable names in **≤1 SQL `IN (...)` query per entity kind** (`agentName` from `agents.config.name`, `conversationTitle`, `requirementTitle`, `projectName`, and `workflowName` from `<workflowId>.workflow.json` `meta.name`).
- Wired into `agent-run`, `artifact`, `coding`, `conversation`, `requirement`, and `workflow` HTTP routes so Web renders human names via `<EntityLink />` rather than raw ULIDs.
- Cross-surface filter queries supported by backend:
  - `GET /api/artifacts`: `?folder`, `requirementId`, `conversationId`, `workflowExecutionId`, `agentId`, `projectId`
  - `GET /api/conversations`: `?agentId`, `requirementId`, `projectId`
  - `GET /api/requirements`: `?closed`, `projectId`, `conversationId`
  - `GET /api/workflow-executions`: `?workflowId`, `requirementId`, `conversationId`, `projectId`
  - `GET /api/coding/terminals`: `?conversationId`, `requirementId`, `projectId`, `agentId`

## See also

- [Web Surface](./web-surface.md) — How Next.js consumes `/ws/ahp` and renders `<EntityLink />`
- [Lark Surface](./lark-surface.md) — How `apps/lark-bot` consumes `/ws/ahp` for CardKit cards and text delivery
- [E2E Contract Rules](./e2e-contract-rules.md) — Zero-EventSource rule and single-source contract gates
