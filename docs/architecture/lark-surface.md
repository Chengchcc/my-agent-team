---
title: Lark Surface
description: Lark/Feishu integration (apps/lark-bot + backend lark-bot feature) — official channel SDK inbound & doc comments, 3-layer access gate, 10 local SQLite tables, CardKit streaming run cards, systemd supervision, setup read model, and E2E flow
tags: [lark, surfaces, backend, cards]
---

# Lark Surface

`apps/lark-bot` bridges Feishu / Lark messaging and cloud-document comment threads onto Product Backend's HTTP API and `/ws/ahp` state mirror. One bot process runs per enabled **PA (front-desk)** agent (workers are forbidden from enabling Lark by `agentConfigSchema`). Product Backend owns conversation facts and supervises the bot lifecycle; `apps/lark-bot` owns local bindings, access requests, delivery deduplication, and CardKit streaming cards.

## Authoritative files

- `apps/lark-bot/src/main.ts` & `channel-adapters.ts` — `@larksuite/channel` WebSocket connection, inbound adapters (`toLarkMessageEvent`, `toCardActionLine`, `toCommentTrigger`)
- `apps/lark-bot/src/inbound-policy.ts` & `access-requests.ts` & `ingest.ts` — 3-layer access gate, stranger `/approve` & `/deny`, `/stop`, `/run`
- `apps/lark-bot/src/ingest-comment.ts` & `comment-scope.ts` & `comment-approval.ts` & `doc-subscription.ts` — Cloud-doc comment threads (`comment:<fileToken>:<commentId>`)
- `apps/lark-bot/src/db/schema.ts` & `bindings-sqlite.ts` — 10 per-agent SQLite tables (`bindings.sqlite`)
- `apps/lark-bot/src/ahp-watcher.ts` & `ahp-delivery.ts` — `/ws/ahp` subscription, voice guard, card-dedup seam, at-least-once text/image delivery
- `apps/lark-bot/src/run-card/card-kit.ts` & `card-pacer.ts` & `card-updater.ts` & `run-card-watcher.ts` & `card-actions.ts` & `queued-card.ts` — Direct Feishu CardKit streaming, 1s/chat pacer, interactive callbacks, 5s terminal watchdog
- `apps/lark-bot/src/topic-routing.ts` & `topic-send.ts` & `merge-hold.ts` — DM flat vs group/topic thread routing and `MergeHold` coalescing
- `apps/backend/src/features/lark-bot/lark-bot-registry-factory.ts` & `systemd-registry.ts` & `registry.ts` — `systemd` vs dev process supervision (ADR 0068)
- `apps/backend/src/features/lark-bot/setup-manager.ts` & `provisioner.ts` & `apps/backend/src/features/agent/lark-surface.ts` — `LarkSetupManager` and `LarkSurfaceView` read model

## Inbound Transport, Access Control & Doc Comments (ADRs 0034, 0044, 0067)

- **Official Channel SDK:** `main.ts` resolves credentials from `lark-cli`'s local profile (`agent:<safeAgentId>`) and opens a long-lived WebSocket via `@larksuite/channel` `createLarkChannel({ keepalive: { enabled: true }, policy: { requireMention: false, dmMode: "open" } })`. Access control stays in `inbound-policy.ts` rather than inside the SDK.
- **3-layer inbound gate (`inbound-policy.ts`):**
  1. **Bot-loop guard:** drops any event where `sender_type !== "user"`.
  2. **DM (`chatType !== "group"`):** fail-closed against `allowedSenders` (**empty denies everyone**; `"*"` allows everyone, case-insensitive). Denied stranger DMs insert into `access_request`, reply once to the stranger, and DM every explicit (non-`"*"`) owner with `/approve <openId>` and `/deny <openId>`. Owner `/approve <openId>` PATCHes `agent.lark.allowedSenders` via backend HTTP.
  3. **Group (`chatType === "group"`):** resolves `groups[chatId]` override → `groupPolicy` (default `disabled`; explicit `disabled` overrides `chatInUse`, default `disabled` preserves pre-existing `chatInUse` rooms; `allowlist` checks per-chat or agent `allowedSenders`). Unmentioned admitted messages return `outcome: "observe"` (posted to ledger without triggering a Run).
- **Slash commands (`ingest.ts`):** `/stop` cancels active `run_card` runs in the chat; `/run` lists runnable workflows; `/run <workflowId> [prompt]` starts an execution and streams progress/human-gate replies.
- **Doc comment threads (`ingest-comment.ts`, `comment-scope.ts`):** ignores `fromAgent === true`; checks `maybeResolveCommentPending()` for natural approval replies before requiring `@bot`; subscribes the file once (`comment_subscription`); maps each thread to synthetic chat ID `comment:<fileToken>:<commentId>` so `conversation_binding`, `ahp-watcher`, and `message_delivery` reuse the exact IM pipeline. *(Note: `commentAckReplyIds`, `commentRunIds`, and `commentPending` are in-memory only and reset across bot restarts.)*

## Local SQLite State (10 Tables)

Each bot stores its own WAL SQLite DB at `<stateRoot>/lark-bot/<safeAgentId>/bindings.sqlite` (guarded by a sibling `pid` lock):

| Table | Role |
|---|---|
| `conversation_binding` | Maps `conversation_id ↔ lark_chat_id`, `chat_type`, `chat_mode`, `topic_root_message_id`. |
| `topic_binding` | Maps `(lark_chat_id, topic_key)` (`thread_id`/`root_id`) → `conversation_id` for group/topic rooms. |
| `input_card` | Tracks queued input cards (`queued \| promoted \| steered \| cancelled`) for seamless adoption into a `run_card`. |
| `member_binding` | Maps `(lark_chat_id, lark_open_id)` → `member_id`. |
| `inbound_message` | Idempotency ledger (`lark_event_id` PK, unique `lark_message_id`, `status: processing \| posted`). Committed **before** `POST /messages` ("prefer dropping an inbound over duplicating a Run"). |
| `message_delivery` | At-least-once outbound dedup `(conversation_id, message_id, lark_chat_id)` (`streaming \| done \| error`). |
| `run_card` | CardKit run-card state (`run_id` PK, `card_kit_id`, `lark_message_id`, `card_seq`, `ack_reaction_id`, `status`, `degraded`, failure flags). |
| `comment_binding` / `comment_subscription` | Maps cloud-doc comment threads to conversations and tracks subscribed file tokens. |
| `access_request` | Tracks stranger DM requests (`open_id` PK, `pending \| approved \| denied`, `decided_by`). |

## Outbound AHP Watcher, CardKit Run Cards & Interactive Callbacks (ADRs 0031, 0032, 0035, 0071)

- **AHP watcher (`ahp-watcher.ts`, `ahp-delivery.ts`):** maintains one `/ws/ahp` subscription per bound `conversationId` (reconnects every `1000 ms`, re-subscribes on `chat/toolCallComplete` to pull `_meta.todos`).
  - **Voice guard:** skips `markdown` parts where `_meta.authorAgentId !== selfAgentId`.
  - **Card-ownership dedup:** suppresses duplicate plain-text sends if `run_card` holds a row for that `runId` with `status !== "fallback_text"`.
  - **Continuity & images:** `systemNotification` with `_meta.newConversationId` rebinds `conversation_binding` + `topic_binding` and swaps the watcher; `contentRef` images download from `/api/artifacts/download` and upload into the topic.
  - **Auto-card on foreign turns (ADR 0071):** `onChatState` starts a run card even for live runs triggered from Web or reminders.
- **CardKit streaming (`run-card/`):**
  - Direct HTTPS to Feishu OpenAPI (`20 s` timeout, 1x token refresh on `401`/`99991663`), serialized per `chatId` via `pacedCardClient` (`CARD_WRITE_MIN_SPACING_MS = 1000` to avoid `230020` chat rate limits).
  - Adds `"OnIt"` emoji reaction on `sourceMessageId` at start and swaps to `"DONE"` once at terminal.
  - Flushes deltas every `150 ms` or `120 chars` (1s elapsed ticker). Marks card `degraded = 1` after **3 consecutive failures** (except 1 fresh attempt per `callId` for interactive approval/ask frames). Once an interactive frame closes streaming mode on a card, subsequent updates use full `updateCard` replaces.
  - **Terminal watchdog & seal:** polls `GET /api/agent-runs/:runId` every `5_000 ms` so dropped AHP terminal frames still seal; fetches canonical `finalAnswerText` (retries `[200, 500, 1000] ms`), replaces the card within a `180_000 ms` congestion budget, and closes streaming. If unreplaceable, sends plain text (3 retries with idempotency key) and sets `status = "fallback_text"`.
  - **Queued cards & `MergeHold`:** queued inputs render an `input_card` (Cancel + Steer buttons) and activate a `30_000 ms` `MergeHold` coalescing follow-up text; when promoted, `startRunCard(..., adopt)` reuses the same card.
- **Interactive button callbacks (`card-actions.ts`):** LRU-deduped (`512` IDs), validated against local `run_card`/`input_card` rows (`messageId` + `chatId` + `runId`/`inputId`), returning synchronous `cardActionToast` responses while invoking backend `/cancel`, `/approval`, `/product-tools/ask/resolve`, `/inputs/:id/{cancel,steer}`, or `/workflow-executions/human-tasks/batch-resolve`.
- **Topic vs DM routing (`topic-routing.ts`):** DMs (`p2p`, ADR 0067) stay flat in one conversation (`replyInThread = false`); groups/topics bind one conversation per `(thread_id | root_id)` (`replyInThread = true`).

## Supervision & Setup Read Model (`features/lark-bot/`, `agent/lark-surface.ts`)

- **Supervision (`lark-bot-registry-factory.ts`, ADR 0068):**
  - `LARK_BOT_SUPERVISOR=systemd`: writes `0600` `<dataDir>/lark-bot/<safeAgentId>.env` and controls `my-agent-team-lark-bot@<safeAgentId>.service` via `systemctl start/stop` (idempotent; backend restarts never bounce bots; `dispose()` leaves units running; polls `is-active` every `5 s`, preferring heartbeat freshness `<= 90 s`).
  - Default dev mode (`DevLarkBotRegistry`): spawns `bun apps/lark-bot/src/main.ts` with `2s..30s` exponential backoff.
  - `RUNNER_ENV=prod` without `systemd`: no-op (`ProdLarkBotRegistry`).
- **Setup wizard (`LarkSetupManager`, `lark_setup_session` table):** spawns `lark-cli config init --new --name agent:<id> --brand <feishu|lark>`, streams the Feishu auth URL directly to SQLite (`10 min` expiry, `24 h` tombstone retention; `POST /api/agents/:id/lark/setup` returns `501` if `lark-cli` unavailable).
- **`LarkSurfaceView` (`GET /api/agents/:id/lark`):** single truth read model joining agent config, `lark_setup_session`, supervisor state, `surface_health` heartbeat (`30 s` interval, `95 s` stale threshold), and required Feishu console scopes (`console`). Status ladder: `not_connected | authorizing | starting | online | degraded | error`.

## End-to-End Lark Message Flow

```text
1. Feishu WS event → @larksuite/channel → toLarkMessageEvent → MergeHold check (if queued)
2. ingest(): drop non-human → fetch agent config → decideInbound() (DM/group/commands/access_request)
3. Fetch up to 4 images → SQLite txn reserves inbound_message (status="processing") & resolves conversation
4. New room? POST /api/conversations → bind tables → start watchConversationOverAhp (/ws/ahp)
5. POST /api/conversations/:cid/messages (source: { kind: "lark", chatId }) → mark inbound "posted"
6. Own triggered run?
   - runId → add "OnIt" reaction + send CardKit run card (paced 1s/chat)
   - queued → send input_card + hold MergeHold (adopted into run_card on promotion)
7. /ws/ahp streams ChatState → ahp-delivery suppresses duplicate text & delivers contentRef images
8. run-card-watcher streams deltas, renders HITL buttons, seals canonical final text (5s watchdog),
   closes streaming, swaps "OnIt" → "DONE" (or falls back to plain text on seal failure)
```

## See also

- [AHP Surface Contract](./ahp-surface-contract.md) — `/ws/ahp` protocol and `_meta.authorAgentId`
- [Proactive & Knowledge](./proactive-and-knowledge.md) — Reminders, Requirements, Wiki, and Attention Debt
- [Operations & Gateway](./operations-and-gateway.md) — Systemd unit template `lark-bot@.service.template`
