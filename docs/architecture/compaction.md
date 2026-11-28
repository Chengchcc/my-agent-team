---
title: Compaction
description: Context compaction in oma (4 triggers, CJK-aware cut points, tool-pair preservation, 6-section + deterministic <files>/<commands>/<qa> state blocks, cross-compaction inheritance), read-side tool pruning, and backend /compact
tags: [oma, runtime, compaction, context]
---

# Compaction

CrewDesk has **two distinct compaction mechanisms** that must not be confused:
1. **`oma` internal compaction (`compactSession`)** — runs inside the `oma` runtime over `oma`'s own session transcript; preserves structured state across repeated compactions (ADR 0053).
2. **Backend `POST /api/conversations/:id/compact`** — folds older `agent_context_entry` rows in SQLite into a `ProductSummaryEntry` for first-turn branch projections; **it does not rewrite an active ACP child's native session** once `cli_session_ref` is bound.

## Authoritative files

- `apps/oh-my-agent/src/core/runtime/compaction.ts` — `compactSession()`, `findCut()`, `adjustCutForToolPairs()`, no-progress guard
- `apps/oh-my-agent/src/core/runtime/compaction-prompt.ts` — `SUMMARIZATION_SYSTEM_PROMPT` (6 sections), `UPDATE_TASK`, `upsertStateBlocks()` (`<files>`, `<commands>`, `<qa>`)
- `apps/oh-my-agent/src/core/runtime/context-estimate.ts` — CJK-aware `estimateTextTokens()`, `estimateContextTokens()`, `triggerRatioFor()`, `isSilentContextOverflow()`
- `apps/oh-my-agent/src/core/runtime/agent-loop-runner.ts` — Proactive threshold, silent-overflow, and error-overflow recovery triggers
- `apps/oh-my-agent/src/core/runtime/tool-pruning.ts` — Opt-in read-side `pruneOldToolResults()`
- `apps/backend/src/features/conversation/summarize.ts` & `service.ts` — Backend `POST /api/conversations/:id/compact` (`BACKEND_SUMMARY_MODEL`)

## 4 Compaction Triggers in `oma`

| # | Trigger | When It Fires | Recovery Semantics |
|---|---|---|---|
| 1 | **Proactive threshold** | Before every model call when `estimateContextTokens(liveEntries, usageAnchor) + summaryTokens + fixedOverhead > limit * triggerRatio` | `triggerRatioFor(window)` reserves `min(max(round(0.15 * window), 16_384), round(window / 2))` (`OMA_COMPACT_RESERVE_TOKENS`, default floor `16_384`; unknown window falls back to `0.7`). |
| 2 | **Silent context overflow** | Provider accepted an oversized prompt without HTTP error: `input + cacheRead > limit` OR (`stopReason === "max_tokens" && outputTokens === 0 && input >= limit * 0.99`) | One-shot per Run (`!stepState.overflowCompacted`); runs `runCompactionRecovery({ forceOnOverflow: true })` and retries in the same turn. |
| 3 | **Provider overflow error** | `ProviderError` with `kind === "overflow"` | One-shot per Run (`!stepState.overflowCompacted`); runs forced compaction and retries in the same turn. |
| 4 | **Manual / explicit** | `session.compact()`, TUI `/compact`, or `LoopRuntime` action `"compact"` | Emits `compaction_start` / `compaction_end` and compacts immediately. |

## Cut-Point Algorithm & Invariants (`compaction.ts`)

1. **Minimum length guard:** returns a no-op if the branch has `< 4` message entries.
2. **CJK-aware token estimation (`context-estimate.ts`):** weights CJK characters at `2/3` tokens/char (`1.5 chars/token`) and non-CJK at `1/4` tokens/char + `4` framing tokens; estimates every `image` block and `tool_result.images` entry at a fixed `IMAGE_ESTIMATE_TOKENS = 1_200` (independent of base64 byte length); avoids double-counting tool message text.
3. **`findCut(messages, budget)`:**
   - **Budgeted:** adds `overheadTokens` (system prompt + serialized tool schemas + prior summary). If `tokensBefore <= limit`, `cutIdx = 0` (no-op). Otherwise advances `cutIdx` from oldest until `remaining <= limit`, clamped to `messages.length - 1` (never covers the newest message).
   - **Unbudgeted** (or `forceOnOverflow` fallback when budgeted cut yields `0`): cuts at `Math.floor(messages.length * 0.6)`.
4. **Tool-pair preservation (`adjustCutForToolPairs`):** if `messages[cutIdx]` is a `tool` message carrying one or more `tool_result` blocks, inspects every `tool_use_id` in that message and pulls `cutIdx` back to the earliest matching `assistant` `tool_use` (looping if that lands on another `tool` message) so no `tool_use`/`tool_result` pair is ever split across the boundary.
5. **No-progress guard:** if every ID in `coveredIds` is already covered by `latestCompaction(branch).coveredIds`, returns a no-op (prevents infinite compaction loops).
6. **Abort safety:** if `signal?.aborted` after the summarizer finishes, no `CompactionEntry` is appended.

## 6-Section Summary & Deterministic State Preservation (ADR 0053)

`compactSession()` calls the Run's own model with `maxTokens = Math.min(4_096, modelMaxOutputTokens)` and `SUMMARIZATION_SYSTEM_PROMPT`, mandating 6 exact sections in order:
`## Goal` → `## Constraints & Preferences` → `## Progress` (`### Done` / `### In Progress` / `### Blocked`) → `## Key Decisions` → `## Next Steps` → `## Critical Context` (plus `## Turn Context (split turn)` if cut mid-turn). Summarizer input is bounded (`serializeConversation` clips individual `tool_result` blocks to `4_000` chars and `tool_use` inputs to `2_000` chars, plus window-proportional `maxTotalChars` middle-elision in `run-runtime.ts`) so overflow-recovery compaction cannot itself overflow the provider window; empty model output throws an error instead of writing a placeholder summary over conversation history.

- **Incremental cross-compaction inheritance:** only **newly uncovered** entries (`coveredEntries` minus `previous.coveredIds`) are sent in `<conversation>` alongside `<previous-summary>` (`UPDATE_TASK`), keeping summarizer input bounded while `CompactionEntry.coversEntryIds` stays cumulative over `0..cutIdx`.
- **Deterministic state blocks (`upsertStateBlocks`):** strips any LLM-written `<files|commands|qa>` blocks and appends machine-generated blocks scanned over the **entire** covered prefix `0..cutIdx` (lossless across repeated compactions):
  - `<files>`: `read`/`write`/`edit` operations tagged `(Read)` / `(Write)` / `(RW)`, sorted, capped at `MAX_SUMMARY_FILES = 20`.
  - `<commands>`: deduplicated `bash` commands (clipped to `200 chars`), latest `MAX_SUMMARY_COMMANDS = 15`.
  - `<qa>`: `*ask_question` calls paired with their answers (clipped to `200 chars`), latest `MAX_SUMMARY_QA = 10`.

## Read-Side Tool Pruning (`tool-pruning.ts`)

`pruneOldToolResults()` is **opt-in** (active only when `pruneConfig` is set in `.oma/settings.json`) and strictly **read-side** (never mutates stored session entries; runs per model call *after* threshold compaction):
- Walks backward inspecting every `tool_result` block inside `tool` messages independently; results beyond `protectTokens` (default `8_000`) on non-protected tools truncate to `[pruned: <lines> lines, <chars> chars] <first 200 chars>…` and drop attached `images` (annotated as `N image(s) dropped`) while keeping `tool_use`/`tool_result` pairing intact.
- Applies only when `savedTokens >= minimumSavings` (default `500`). Does not lower the stored-entry token estimate used by threshold compaction.

## Backend `POST /api/conversations/:id/compact` (`conversation/summarize.ts`)

- Powered by `BACKEND_SUMMARY_MODEL=<provider>/<model>` (validated at boot; malformed env crashes loudly). When unconfigured, returns **HTTP `501`** (`"conversation compaction is not configured"`).
- Retains the newest `KEEP_RECENT_ENTRIES = 20` entries verbatim; folds prior `ProductSummaryEntry` + uncovered `ledger_message` entries (including `tool_use` and `tool_result`) into one plain-prose summary capped at `MAX_SUMMARY_CHARS = 1200` via `contextService.appendSummary()`.
- **Scope boundary:** backend compaction updates `agent_context_branch` for future first-turn `projectAgentContext()` projections (e.g., after a fork or harness switch). Once an ACP branch holds a `cli_session_ref`, the child harness manages its own live session window (`oma` via `compactSession` above; `claude`/`pi`/`omp` via their own native compaction).

## See also

- [Oma Runtime](./oma-runtime.md) — Agent loop integration and session store
- [Conversation & Context](./conversation-and-context.md) — `ProductSummaryEntry`, `projectAgentContext()`, and `cli_session_ref`
- [Models & Providers](./models-and-providers.md) — Model context windows and `maxOutputTokens`
