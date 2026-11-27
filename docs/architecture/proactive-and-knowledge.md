---
title: Proactive & Knowledge
description: Ambient rules & semantic assessment (proactive_event), reminders, Requirements (stored vs derived status), Git-backed shared Wiki, unified recall & cross-process memory, and attention debt
tags: [backend, proactive, wiki, recall, requirements]
---

# Proactive & Knowledge

This document covers the five backend capabilities that keep CrewDesk stateful across turns and rooms: **Reminders**, **Requirements**, the **Git-backed Wiki**, **Unified Recall & Cross-Process Memory**, and **Attention Debt**. (Legacy `features/proactive/` ambient rules & semantic assessment were retired.)

## Authoritative files

- `apps/backend/src/features/reminder/service.ts` & `cron.ts` & `http.ts` — One-shot & 5-field cron reminders
- `apps/backend/src/features/requirement/domain.ts` & `service.ts` & `http.ts` — Requirement lifecycle & derived view status
- `apps/backend/src/features/wiki/domain.ts` & `adapter-fs.ts` & `service.ts` & `http.ts` — Git-backed Markdown Wiki, CAS revisions, lint
- `apps/backend/src/features/recall/domain.ts` & `cues.ts` & `recall.ts` & `memory-recall.ts` — Unified recall across 6 sources & cross-process memory reader
- `apps/backend/src/features/agent-run/recall.ts` — Turn-start recall fan-out, prompt rendering, slot evidence
- `apps/backend/src/features/agent-run/http.ts` — `GET /api/attention`, `POST /api/attention/seen`, `POST /api/attention/:actionId/correct`, `/api/attention/draft`

## Reminders (`features/reminder/`)

- Stored in `reminder` (`conversation_id` FK `CASCADE`, `created_by`, `text`, future `fire_at`, optional 5-field Vixie `recurrence`, `fired_at`).
- `nextCronRun()` (`reminder/cron.ts`) uses standard dom/dow OR semantics when both are restricted, normalizes Sunday `7 → 0`, and searches up to 370 days ahead.
- `fireDue(limit = 20)` runs once at startup and on a **30-second `setInterval`**: posts `REMINDER_BANNER_PREFIX` (`"⏰ Reminder (set earlier): "`) + `text` into the bound conversation with `authorization: "system"`.
- **Failure rule:** marks `fired_at` even if delivery errors (preventing infinite retries against deleted rooms). Recurring rows reschedule to `nextCronRun()` or retire if no match exists.
- **Routes:** `GET /api/reminders?conversationId=`, `POST /api/reminders` (201), `POST /api/reminders/:id/snooze`, `DELETE /api/reminders/:id`; product tools `remind_me`, `reminder_list`, `reminder_cancel`.

## Requirements (`features/requirement/`)

A `Requirement` (`requirement` table, ADR 0074/0077) is the stable work goal the PA identifies and tracks across conversations, rework attempts, and workers.

- **Stored vs derived status (`requirement/domain.ts` → `deriveRequirementStatus`):**
  - Stored `status`: `open | done | cancelled` only. A summary edit can never mark work finished.
  - Derived `RequirementViewStatus` precedence:
    1. `done` or `cancelled` (if stored)
    2. `waiting_user` (any open `pending_action` on linked runs where `(owner ?? "user") === "user"`)
    3. `in_progress` (any linked run in `running | waiting`)
    4. If linked runs exist and all are terminal: `pending_acceptance` **iff** the newest run by `createdAt` has `verification === "passed"`; otherwise `in_progress`
    5. `open` (no runs yet)
- **Dispatch resolution:** `resolveForDispatch` prefers an explicit `requirementId`, falls back to the newest `open` requirement for `originConversationId`, or creates a new one from the dispatch brief.
- **Workspace ownership:** when a worker runs in a project-bound room, the requirement owns the Git checkout at `<dataDir>/workspaces/<requirementId>/<projectId>` on branch `req/<requirementId>` (see [Workspaces & Projects](./workspaces-and-projects.md)).
- **Acceptance evidence (ADR 0080):** `PATCH /api/requirements/:id` with `status: "done"` snapshots `accepted_at` and `accepted_evidence` (all current linked run IDs and verification verdicts).
- **Routes:** `GET /api/requirements?closed=1&projectId=&conversationId=`, `GET /api/requirements/:id`, `PATCH /api/requirements/:id`; product tools `requirement_track`, `requirement_query`.

## Git-Backed Shared Wiki (`features/wiki/`)

ADR 0078 removed legacy `knowledge_pack` tables and converged product knowledge onto a single Git-backed Markdown tree at `<BACKEND_DATA_DIR>/wiki` (auto-seeds `index.md` and `schema.md`; degrades gracefully if `git` is unavailable).

- **5 Spaces (`WIKI_SPACES`):** `personal/<agentId>/<name>.md` (writable **only** by `agentId === owner`), `projects/`, `decisions/`, `concepts/`, `lessons/`. Raw references live under `raw/conversations/` (pointer files, never ledger copies) and `raw/files/`.
- **Frontmatter & CAS (`wiki/domain.ts`):** YAML subset carrying `title`, `maintainedBy`, `status` (`draft | confirmed | superseded`), `updated`, `sources[]`, `supersedes[]`. Revision token is `sha256(fileText).slice(0, 16)`.
- **Write discipline (`wiki/service.ts`, `adapter-fs.ts`):**
  - Writes happen **exclusively** through the 6 `wiki_*` product tools (`wiki_read`, `wiki_query`, `wiki_create`, `wiki_patch`, `wiki_lint`, `wiki_source_add`). HTTP routes are strictly **read-only**.
  - `safeResolve()` blocks null bytes, `.`, `..`, `.git`, symlinks, and realpath escapes. Writes use atomic `.tmp-<pid>` + `renameSync` + `git commit` (`GIT_AUTHOR_NAME = author`) behind a per-page promise lock.
  - `wiki_patch` enforces CAS (`expected_revision` mismatch → `{ ok: false, reason: "conflict", current }`), preserves original `maintainedBy`, union-merges `sources`/`supersedes`, appends `log.md`, rebuilds `index.md`, and returns inline lint findings.
- **Lint rules (`wiki_lint`):** flags `unsourced` (`sources.length === 0`), `orphan` (zero inbound `[[Title]]` or `](path)` links, excluding `index.md`), and `missing-supersedes-target`.
- **Read-only HTTP routes:** `GET /api/wiki/{pages,page,query,backlinks,graph,lint}`.

## Unified Recall & Cross-Process Memory (`features/recall/`, ADRs 0055/0058/0064/0065)

One uniform entry point (`recall/recall.ts`) serves both turn-start context enrichment and capability selection:

- **6 Sources (`RecallSource`):** `history`, `qa`, `capability`, `memory`, `requirement`, `skill`. Every response returns `{ hits, searched, skipped }` — unavailable sources are **never silently dropped** (e.g., `skill` always reports skipped: `"lives in the run's process (skill packs)"`).
- **Cue-gated activation (`recall/cues.ts`):** `extractCues(text)` checks 23 CN/EN back-reference cues (`这个`, `刚才`, `上次`, `this`, `earlier`, etc.) and 5 identifier regexes (`#123`, `seq:N`, file paths, `ALL_CAPS_CONST`, semver; query capped at `200 chars`). If `needsRecall(cues)` is false, turn recall skips DB lookups completely.
- **Turn-start fan-out (`agent-run/recall.ts`):** fans out over `["qa", "history", "memory", "requirement"]` (`MAX_HITS = 6`, `MAX_PINNED_QA = 3`, `MAX_HISTORY = 6`, `HIT_CHARS = 300`), rendering `## Recall (this turn)` with timestamps and provenance refs (capped at 8 in dispatch briefs).
- **Long-term memory (`remember` tool → Wiki & `recall/memory-recall.ts`):**
  - **Producer (`remember` tool):** permitted **only** when `run.authorization === "user"`. Appends deduplicated `- [YYYY-MM-DD] <text>` entries directly to `personal/<agentId>/memories.md` in the Git-backed Wiki (with `conversation:<id>` source citation and CAS retry), unifying backend memory on the Wiki surface.
  - **Reader (`createMemoryRecall`):** opens `<workspace>/.oma/memory/memory.db` **strictly read-only** if it already exists for standalone `oma` runs (never creates it; hybrid vector + FTS when `BACKEND_EMBEDDING_MODEL` is configured, else keyword-only; swallows lock/corrupt errors gracefully).

## Attention Debt (`GET /api/attention`, ADR 0061)

Derived read model tracking everything demanding or awaiting operator attention:

| Bucket | Source Query | Cap | Read/Clear Semantics |
|---|---|---|---|
| `awaitingYou` | Open `pending_action` rows where `owner IS NULL OR owner = 'user'` | 200 | Marked seen via `POST /api/attention/seen` (`seen_at`); unsent free-text drafts persist in `answer_draft` (`GET/PUT /api/attention/draft`, auto-deleted once action leaves `pending`). |
| `waitingAgent` | Resolved `pending_action` rows on still-active (`running \| waiting`) runs | 200 | Shows agent-answered worker requests; operator can override via `POST /api/attention/:actionId/correct`. |
| `unread` | Terminal runs where `result_notified_at IS NOT NULL AND result_seen_at IS NULL` | 50 | Cleared when the operator opens the conversation or marks seen (`result_seen_at`). |

## See also

- [Team Coordination](./team-coordination.md) — How PA uses Wiki recall, Requirements, and `answer_worker_request`
- [Oma Runtime](./oma-runtime.md) — Standalone autonomous memory (`.oma/memory/memory.db` and `learn`)
- [Data Model](./data-model.md) — `requirement`, `proactive_event`, `reminder`, `pending_action`, `answer_draft` schemas
