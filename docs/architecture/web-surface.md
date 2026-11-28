---
title: Web Surface
description: Next.js 15 App Router console — session auth & BFF proxy, Eden Treaty client, navigation IA & English-source i18n skin, split chat inspector, ProposalCard, Coding PTY pane, and E2E message flow
tags: [web, surfaces, nextjs, ui]
---

# Web Surface

`apps/web` is the Next.js 15 App Router console for CrewDesk. It holds **no database** and **no browser-exposed backend credentials**: every HTTP request flows through the server-side BFF proxy (`/api/bff/[...path]`) typed via Eden Treaty, while live conversation and terminal updates stream over `/ws/ahp` and `/ws/coding/:id`.

## Authoritative files

- `apps/web/src/middleware.ts` & `apps/web/src/lib/session.ts` & `apps/web/src/lib/auth.ts` — Edge session verification (`maw_session`), login rate limiter, password verification
- `apps/web/src/app/api/bff/[...path]/route.ts` & `apps/web/src/lib/bff.ts` — Authenticated BFF proxy & `rewriteWsTicket()`
- `apps/web/src/lib/client.ts` & `apps/web/src/lib/api.ts` — Eden Treaty (`treaty<App>`) & `unwrap()`
- `apps/web/src/lib/ahp.ts` & `apps/web/src/lib/chat-state.ts` & `apps/web/src/hooks/useConversation.ts` — AHP WebSocket lifecycle and `ChatState` projection
- `apps/web/src/components/NavRail.tsx` — 5-section navigation IA, virtualized root/child rooms, language switcher
- `apps/web/src/lib/i18n.ts` & `apps/web/src/lib/locales/zh.ts` — English-source i18n skin (ADR 0079)
- `apps/web/src/components/ConversationPanel.tsx` & `ConversationCanvas.tsx` & `ChatSidePreviewPane.tsx` & `chat-inspector-context.tsx` — Shared conversation panel and split inspector
- `apps/web/src/components/ProposalCard.tsx`, `Markdown.tsx`, `ui/entity-link.tsx`, `ui/active-filter-bar.tsx` — Diff proposals, entity links, filter chips
- `apps/web/src/features/coding/components/coding-page.tsx` & `terminal-pane.tsx` & `locate.ts` — xterm.js PTY panes and `?locate=1` deep linking

## Auth, Session & BFF Proxy

- **Session cookie (`maw_session`):** WebCrypto HMAC-SHA256 signed by `SESSION_SECRET`, 7-day TTL, `HttpOnly; SameSite=Lax; Path=/` (`; Secure` when `SESSION_COOKIE_SECURE=1`). `middleware.ts` checks every route except `/login`, `/api/auth`, `/_next`, `/favicon`, redirecting unauthenticated requests to `/login?next=...`.
- **Login (`POST /api/auth/login`):** global rate limiter (`5` failures → `60 s` lock → `429`). Calls backend `POST /api/auth/verify` (argon2id stored hash when `source === "stored"`; falls back to timing-safe `MOCK_PASSWORD` or fail-closed ephemeral UUID if unseeded). `POST /api/auth/logout` clears cookie; `GET /api/auth/session` returns `{ userId }`.
- **BFF proxy (`/api/bff/[...path]`):** requires a valid `maw_session` (`401` otherwise), strips an optional leading `api` segment, injects `x-auth-token: BACKEND_AUTH_TOKEN` and `x-user-id: session.userId`, strips hop-by-hop headers, and intercepts `ahp/ws-ticket` for `rewriteWsTicket()` (ADR 0069).
- **Typed client (`lib/client.ts`):** `treaty<App>("/api/bff", { keepDomain: true, fetch: { credentials: "include" }, parseDate: false })` (`parseDate: false` prevents ISO strings becoming `Date` objects). SSR pages use `createServerClient(backendUrl, authToken)`. `unwrap()` redirects to `/login` on `401` and throws `ApiError` otherwise.

## Navigation IA, Routes & i18n Skin

`NavRail.tsx` organizes the console into five groups:

| Group | Routes |
|---|---|
| **Work** | `/today` (Attention inbox, active requirements, unread results, reminders, saved bookmarks), `/chat` & `/chat/[conversationId]` (`?requirement`, `project`, `agent`), `/requirements` & `/requirements/[requirementId]` (`?project`, `conversation`, `status`), `/workflows` & `/workflows/[workflowId]` & `.../executions/[executionId]`, `/artifacts` (`?folder`, `requirement`, `conversation`, `execution`, `project`, `agent`, `kind`), `/coding` (`?locate=1`, `conversation`, `requirement`, `project`, `agent`, `t`) |
| **Recent conversations** | Virtualized (`@tanstack/react-virtual`) root conversations with collapsible child worker rooms (`parentConversationId`), unread dots, and `+` new room dialog |
| **Team & Projects** | `/team` & `/team/[agentId]{,/edit}` & `/team/new/edit`, `/team/projects` & `/team/projects/[id]` *(note: projects live under `/team/projects`, not `/projects`)* |
| **Capabilities** | `/wiki` & `/wiki/page?path=`, `/team/skills`, `/team/mcp` |
| **System** | `/system` (`runs`/`processes`/`usage`), `/system/runs/[runId]`, `/system/authority`, `/system/settings`, `/channels` (PA Lark surface status & `AddLarkChannelSheet`) |

*(Known gap: `/workflows/page.tsx` does not yet read `?requirement` / `?project` URL query parameters.)*

- **English-source i18n skin (ADR 0079):** all JSX/TS source strings are English keys passed to `t(key, vars?)` (missing keys fall back to English). `apps/web/src/lib/locales/zh.ts` merges 15 per-page dictionaries (`pages/index.test.ts` enforces zero key collisions); `scripts/audit-ui.ts` rejects any CJK character outside `apps/web/src/lib/locales/`. Locale persists in cookie `ui.locale` and `localStorage`.
- **UI component discipline:** always use `@/components/ui/*` (`Button`, `Select`, `Input`, `Textarea`, `Dialog`, `AlertDialog`, `useConfirm()`), never native `<select>`, `window.confirm`, or `window.alert`.

## Core UI Primitives

- **`ConversationPanel` & Split Inspector (`ConversationCanvas`, `ChatSidePreviewPane`, `ChatInspectorContext`):**
  - `ConversationPanel` renders both full-page chats and embedded side sheets (`density`, `marksSeen`), displaying `TodoPanel`, `Timeline` (filtering out tool bubbles where `hasDedicatedEvent(tool.name)` is true), approval/ask cards, and `Composer`.
  - On `/chat/[conversationId]`, a collapsible right-hand aside shows **Session Context** (linked requirements, artifacts, coding terminals, workflow executions, collapsed diagnostics) and switches inline to `<ChatSidePreviewPane />` when clicking any `artifacts://` card or `/requirements/<id>` chip inside `Markdown.tsx` — without covering the composer. Outside chat, clicks fall back to modal `<ArtifactPreviewSheet />`.
- **`ProposalCard`:** displays a field-by-field diff (`Field | Current form | Suggested`), flags stale edits if the human modified the form after the proposal arrived, and offers **Apply to form** (draft only; never auto-saves) or **Discard suggestion**.
- **`EntityLink` & `ActiveFilterBar`:** `EntityLink` renders human labels (`entityLabelText`) with fallback `<Kind> · <first 8 chars>…` and full ID in `title`; `ActiveFilterBar` renders removable URL filter chips across Work views.
- **Coding Workbench (`features/coding/`, ADR 0083):** Herdr-style workspace-first sidebar (`CodingRail`) backed by `GET /api/coding/workspaces` (human requirement titles, git branch/`↑ahead`, rolled-up ACP+PTY status dots, nested pane rows, plus separate Agent Workspaces for ADR 0073 panes). Opening `/coding` automatically resumes the previous coding agent terminal via `pickResumeTerminal()` (URL `?t=` → `localStorage` last terminal/workspace → highest-attention live pane) without ever auto-spawning; `resolveLocate()` strictly focuses existing terminals on `?locate=1`. Global `<CodingNotifier />` (mounted in `AppShell`) detects `working → idle`, harness exit, ACP run completion, and `blocked` transitions to emit actionable toasts + background OS desktop notifications (`Notification` API), paired with a toolbar bell toggle and live `NavRail` status indicator. Preserves `?requirement=&conversation=&project=&t=` via `buildCodingUrl()`, renders a top-bar **`Conversation` ↔ `Coding`** switcher, a read-only workspace **Diff** dialog (`GET /api/projects/:id/worktrees/:workspaceId/diff`), and an **ACP Worker anti-collision banner**. `TerminalPane` mounts xterm.js + `FitAddon` + `ResizeObserver`, supports multi-harness CLI launch (`oma` / `claude` / `pi` / `omp`), mints a ticket via `POST /api/bff/api/coding/ws-ticket`, connects `${wsBase}/ws/coding/${id}?ticket=...`, and auto-reconnects (`1500 ms` on close / `2000 ms` on ticket error) with fresh tickets.

## End-to-End Web Message Flow

```text
1. /chat/[cid] mounts → GET /api/bff/api/conversations/:cid (resolve agentId)
2. connectAhpChat() → POST /api/bff/api/ahp/ws-ticket (BFF rewrites wsBase)
                    → WS ${wsBase}/ws/ahp?ticket=...
3. AhpClient.initialize({ clientId: "web:<cid>", initialSubscriptions: ["ahp-chat:/<cid>"] })
   → ChatState snapshot hydrates Timeline, transients, todos, continuationControl
4. Human submits in Composer → optimistic local send
   → POST /api/bff/api/conversations/:cid/messages (mode: "follow_up" if busy; addressedTo if >1 member)
5. Backend runs ACP child → AhpChatWriter dispatches chat/* actions over /ws/ahp
6. Browser reduces actions with upstream chatReducer;
   on chat/toolCallComplete → re-subscribes to pull DB-only _meta.todos updates
7. Run settles → foldCommittedTurn dispatches canonical turn + chat/turnComplete
   → optimistic bubble collapses onto _meta.messageId; artifacts query invalidates
8. HITL actions:
   - Approval → POST /api/bff/api/agent-runs/:runId/approval
   - Ask      → POST /api/bff/api/product-tools/ask/resolve
   - Stop     → POST /api/bff/api/agent-runs/:runId/cancel
```

## See also

- [AHP Surface Contract](./ahp-surface-contract.md) — `/ws/ahp` protocol, `_meta` fields, and `EntityLabelResolver`
- [E2E Contract Rules](./e2e-contract-rules.md) — `audit:contracts` and `audit:ui` rules for `apps/web`
- [Workspaces & Projects](./workspaces-and-projects.md) — Backend `coding` PTY registry and worktree whitelist
